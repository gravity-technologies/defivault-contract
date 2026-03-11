import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { expectEventOnce } from "../helpers/events.js";
import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault adversarial behavior", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, l2Recipient, treasury, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  async function setupVaultForToken(tokenAddress: `0x${string}`) {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const baseToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const { vaultImplementation: vaultImpl } =
      await deployVaultImplementation(viem);
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [
        addr(admin),
        bridge.address,
        baseToken.address,
        270n,
        addr(l2Recipient),
        wrappedNative.address,
        addr(treasury),
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);
    const vault = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      proxy.address,
    );

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([allocatorRole, addr(allocator)]);
    await vault.write.grantRole([rebalancerRole, addr(rebalancer)]);

    await vault.write.setPrincipalTokenConfig([
      tokenAddress,
      {
        supported: true,
      },
    ]);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
    );
    const vaultAsRebalancer = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: rebalancer },
      },
    );

    return { vault, bridge, baseToken, vaultAsAllocator, vaultAsRebalancer };
  }

  function componentTotal(breakdown: {
    components: ReadonlyArray<{ amount: bigint }>;
  }): bigint {
    return breakdown.components.reduce(
      (sum, component) => sum + component.amount,
      0n,
    );
  }

  it("blocks reentrancy through malicious strategy callback", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, vaultAsAllocator } = await setupVaultForToken(token.address);

    await token.write.mint([vault.address, 1_000_000n]);
    const malicious = await viem.deployContract("MockReentrantStrategy", [
      vault.address,
      token.address,
    ]);

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      malicious.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, malicious.address]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocatePrincipalToStrategy([
        token.address,
        malicious.address,
        10_000n,
      ]),
      vaultAsAllocator,
      "ReentrancyGuardReentrantCall",
    );
  });

  it("reverts when ERC20 approve/transfer returns false", async function () {
    const badToken = await viem.deployContract("MockFalseReturnERC20");
    const { vault, vaultAsAllocator } = await setupVaultForToken(
      badToken.address,
    );
    await badToken.write.mint([vault.address, 1_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "SAFE_STRAT",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      badToken.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocatePrincipalToStrategy([
        badToken.address,
        strategy.address,
        100_000n,
      ]),
      vaultAsAllocator,
      "SafeERC20FailedOperation",
    );
  });

  it("uses measured deltas and emits mismatch telemetry when strategy over-reports", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, vaultAsAllocator } = await setupVaultForToken(token.address);

    await token.write.mint([vault.address, 1_000_000n]);
    const overreporting = await viem.deployContract(
      "MockOverreportingStrategy",
      [vault.address],
    );

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      overreporting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      overreporting.address,
      300_000n,
    ]);
    await overreporting.write.setReportExtra([50_000n]);

    const idleBefore = (await vault.read.idleTokenBalance([
      token.address,
    ])) as bigint;
    const hash = await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
      token.address,
      overreporting.address,
      120_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const idleAfter = (await vault.read.idleTokenBalance([
      token.address,
    ])) as bigint;

    assert.equal(idleAfter - idleBefore, 120_000n);

    const deallocateEvent = expectEventOnce(
      receipt,
      vault,
      "PrincipalDeallocatedFromStrategy",
    );
    assert.equal(deallocateEvent.received, 120_000n);

    const mismatchEvent = expectEventOnce(
      receipt,
      vault,
      "StrategyReportedReceivedMismatch",
    );
    assert.equal(mismatchEvent.reported, 170_000n);
    assert.equal(mismatchEvent.actual, 120_000n);

    const allBefore = (await vault.read.idleTokenBalance([
      token.address,
    ])) as bigint;
    const allHash =
      await vaultAsAllocator.write.deallocateAllPrincipalFromStrategy([
        token.address,
        overreporting.address,
      ]);
    const allReceipt = await publicClient.waitForTransactionReceipt({
      hash: allHash,
    });
    const allAfter = (await vault.read.idleTokenBalance([
      token.address,
    ])) as bigint;

    assert.equal(allAfter - allBefore, 180_000n);

    const allDeallocateEvent = expectEventOnce(
      allReceipt,
      vault,
      "PrincipalDeallocatedFromStrategy",
    );
    assert.equal(allDeallocateEvent.requested, 2n ** 256n - 1n);
    assert.equal(allDeallocateEvent.received, 180_000n);
  });

  it("handles fee-on-transfer token with conservative accounting", async function () {
    const feeToken = await viem.deployContract("MockFeeOnTransferERC20", [
      "Fee Token",
      "FEE",
      6,
      100n,
      addr(treasury),
    ]);
    const { vault, vaultAsAllocator } = await setupVaultForToken(
      feeToken.address,
    );
    await feeToken.write.mint([vault.address, 1_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "FEE_STRAT",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      feeToken.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      feeToken.address,
      strategy.address,
      100_000n,
    ]);

    const stratAssets = componentTotal(
      await vault.read.strategyAssetBreakdown([
        feeToken.address,
        strategy.address,
      ]),
    );
    assert.equal(stratAssets, 99_000n);

    await vaultAsAllocator.write.deallocateAllPrincipalFromStrategy([
      feeToken.address,
      strategy.address,
    ]);
    const finalIdle = (await vault.read.idleTokenBalance([
      feeToken.address,
    ])) as bigint;
    assert.ok(finalIdle < 1_000_000n);
  });

  it("enforces harvest minReceived on treasury-side net receipt for fee-on-transfer tokens", async function () {
    const feeToken = await viem.deployContract("MockFeeOnTransferERC20", [
      "Fee Token",
      "FEE",
      6,
      100n,
      addr(other),
    ]);
    const { vault, vaultAsAllocator } = await setupVaultForToken(
      feeToken.address,
    );
    await feeToken.write.mint([vault.address, 1_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "FEE_HARVEST",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      feeToken.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      feeToken.address,
      strategy.address,
      100_000n,
    ]);

    // Principal tracked by vault is 100_000, while strategy only received 99_000 (1% fee).
    // Add external yield so harvestable yield becomes 20_000.
    await feeToken.write.mint([strategy.address, 21_000n]);
    await strategy.write.setAssets([feeToken.address, 120_000n]);

    await viem.assertions.revertWithCustomError(
      vault.write.harvestYieldFromStrategy([
        feeToken.address,
        strategy.address,
        20_000n,
        19_603n,
      ]),
      vault,
      "SlippageExceeded",
    );

    const treasuryAddress =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await feeToken.read.balanceOf([
      treasuryAddress,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      feeToken.address,
      strategy.address,
      20_000n,
      19_602n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = (await feeToken.read.balanceOf([
      treasuryAddress,
    ])) as bigint;

    // 20_000 strategy request -> 19_800 to vault (1% fee) -> 19_602 to treasury (1% fee).
    assert.equal(treasuryAfter - treasuryBefore, 19_602n);
    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    assert.equal(harvested.requested, 20_000n);
    assert.equal(harvested.received, 19_602n);
  });

  it("harvest emits mismatch telemetry for over-reporting strategies", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, vaultAsAllocator } = await setupVaultForToken(token.address);
    await token.write.mint([vault.address, 1_000_000n]);

    const overreporting = await viem.deployContract(
      "MockOverreportingStrategy",
      [vault.address],
    );
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      overreporting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      overreporting.address,
      300_000n,
    ]);

    await token.write.mint([overreporting.address, 60_000n]);
    await overreporting.write.setAssets([token.address, 360_000n]);
    await overreporting.write.setReportExtra([7_000n]);

    const treasuryAddress =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await token.read.balanceOf([
      treasuryAddress,
    ])) as bigint;

    const hash = await vault.write.harvestYieldFromStrategy([
      token.address,
      overreporting.address,
      30_000n,
      30_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = (await token.read.balanceOf([
      treasuryAddress,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, 30_000n);

    const mismatch = expectEventOnce(
      receipt,
      vault,
      "StrategyReportedReceivedMismatch",
    );
    assert.equal(mismatch.requested, 30_000n);
    assert.equal(mismatch.reported, 37_000n);
    assert.equal(mismatch.actual, 30_000n);

    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    assert.equal(harvested.received, 30_000n);
  });

  it("continues emergency unwind when one strategy reverts", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, bridge, vaultAsAllocator, vaultAsRebalancer } =
      await setupVaultForToken(token.address);
    await token.write.mint([vault.address, 1_000_000n]);

    const revertingStrategy = await viem.deployContract(
      "MockRevertingStrategy",
    );
    const healthyStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "HEALTHY",
    ]);

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      revertingStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      healthyStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      healthyStrategy.address,
      900_000n,
    ]);

    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 400_000n]);

    assert.equal(await bridge.read.lastAmount(), 400_000n);
    assert.equal(await bridge.read.sendCount(), 1n);
  });

  it("bridges exact requested amount using idle plus partial strategy unwind", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, bridge, vaultAsAllocator, vaultAsRebalancer } =
      await setupVaultForToken(token.address);
    await token.write.mint([vault.address, 1_000_000n]);

    const healthyStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "HEALTHY",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      healthyStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      healthyStrategy.address,
      900_000n,
    ]);

    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 350_000n]);

    assert.equal(await bridge.read.lastAmount(), 350_000n);
    // Idle before emergency = 100_000, so exactly 250_000 should be pulled from strategy.
    assert.equal(
      componentTotal(
        await vault.read.strategyAssetBreakdown([
          token.address,
          healthyStrategy.address,
        ]),
      ),
      650_000n,
    );
  });

  it("still bridges from idle when all strategies revert but idle is sufficient", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, bridge, vaultAsRebalancer } = await setupVaultForToken(
      token.address,
    );
    await token.write.mint([vault.address, 500_000n]);

    const revertingA = await viem.deployContract("MockRevertingStrategy");
    const revertingB = await viem.deployContract("MockRevertingStrategy");

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      revertingA.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      revertingB.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 200_000n]);

    assert.equal(await bridge.read.lastAmount(), 200_000n);
  });

  it("reverts emergency send when all strategies revert and idle is insufficient", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, vaultAsRebalancer } = await setupVaultForToken(
      token.address,
    );
    await token.write.mint([vault.address, 100_000n]);

    const revertingA = await viem.deployContract("MockRevertingStrategy");
    const revertingB = await viem.deployContract("MockRevertingStrategy");

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      revertingA.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      revertingB.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 200_000n]),
      vaultAsRebalancer,
      "InvalidParam",
    );
  });

  it("propagates bridge forced reverts on normal and emergency paths", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, bridge, vaultAsRebalancer } = await setupVaultForToken(
      token.address,
    );
    await token.write.mint([vault.address, 1_000_000n]);

    await bridge.write.setForceRevert([true]);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n]),
      bridge,
      "BridgeForcedRevert",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 100_000n]),
      bridge,
      "BridgeForcedRevert",
    );
  });

  it("tracks bridge base-token fee used for rebalance", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, bridge, vaultAsRebalancer } = await setupVaultForToken(
      token.address,
    );
    await token.write.mint([vault.address, 1_000_000n]);

    await bridge.write.setMinFeeValue([5n]);
    await vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n]);
    assert.equal(await bridge.read.lastFeeValue(), 5n);
  });

  it("permits defensive exits after token support is disabled", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const { vault, bridge, vaultAsAllocator, vaultAsRebalancer } =
      await setupVaultForToken(token.address);
    await token.write.mint([vault.address, 1_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "DEFENSIVE",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      strategy.address,
      700_000n,
    ]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      {
        supported: false,
      },
    ]);

    await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
      token.address,
      strategy.address,
      200_000n,
    ]);
    await vaultAsAllocator.write.deallocateAllPrincipalFromStrategy([
      token.address,
      strategy.address,
    ]);

    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 100_000n]);

    assert.equal(await bridge.read.lastAmount(), 100_000n);
  });
});
