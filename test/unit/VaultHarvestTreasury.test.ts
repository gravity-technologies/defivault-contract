import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, keccak256, stringToHex } from "viem";

import { expectEventCount, expectEventOnce } from "../helpers/events.js";
import {
  configureYieldRecipientTimelockController as sharedConfigureYieldRecipientTimelockController,
  executeSetYieldRecipientViaTimelock as sharedExecuteSetYieldRecipientViaTimelock,
  increaseTimeAndMine as sharedIncreaseTimeAndMine,
} from "../helpers/timelock.js";
import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault harvest and treasury flows", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other, harvester] =
    wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) throw new Error("wallet has no account");
    return wallet.account.address;
  }

  function writeSetYieldRecipient(
    vaultLike: unknown,
    newYieldRecipient: `0x${string}`,
  ): Promise<`0x${string}`> {
    return (
      vaultLike as {
        write: {
          setYieldRecipient: (args: [`0x${string}`]) => Promise<`0x${string}`>;
        };
      }
    ).write.setYieldRecipient([newYieldRecipient]);
  }

  async function configureYieldRecipientTimelockController(
    vault: {
      address: `0x${string}`;
      write: {
        setYieldRecipientTimelockController: (
          args: [`0x${string}`],
        ) => Promise<`0x${string}`>;
      };
      abi: unknown;
    },
    minDelay: bigint = 2n,
  ) {
    return sharedConfigureYieldRecipientTimelockController(
      viem,
      vault,
      addr(admin),
      minDelay,
    );
  }

  async function executeSetYieldRecipientViaTimelock(
    vault: { address: `0x${string}`; abi: unknown },
    timelock: {
      write: {
        schedule: (
          args: [
            `0x${string}`,
            bigint,
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
            bigint,
          ],
        ) => Promise<`0x${string}`>;
        execute: (
          args: [
            `0x${string}`,
            bigint,
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
          ],
        ) => Promise<`0x${string}`>;
      };
    },
    newYieldRecipient: `0x${string}`,
    minDelay: bigint,
  ): Promise<`0x${string}`> {
    return sharedExecuteSetYieldRecipientViaTimelock(
      publicClient as any,
      vault,
      timelock as any,
      newYieldRecipient,
      minDelay,
    );
  }

  async function increaseTimeAndMine(seconds: number) {
    return sharedIncreaseTimeAndMine(publicClient as any, seconds);
  }

  async function deployBase() {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
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
        grvtBridgeProxyFeeToken.address,
        270n,
        addr(l2Recipient),
        wrappedNative.address,
        addr(pauser),
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

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 2_000_000n]);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.grantRole([
      await vault.read.REBALANCER_ROLE(),
      addr(rebalancer),
    ]);
    await vault.write.grantRole([await vault.read.PAUSER_ROLE(), addr(pauser)]);

    await vault.write.setVaultTokenConfig([token.address, { supported: true }]);
    await vault.write.setBridgeableVaultToken([token.address, true]);

    const stratA = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "STRAT_A",
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      stratA.address,
      { whitelisted: true, active: false, cap: 2_000_000n },
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
    const vaultAsPauser = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: pauser },
      },
    );
    const vaultAsAdmin = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: admin },
      },
    );
    const vaultAsOther = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: other },
      },
    );
    const vaultAsHarvester = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: harvester },
      },
    );

    return {
      bridge,
      grvtBridgeProxyFeeToken,
      wrappedNative,
      vault,
      token,
      stratA,
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      vaultAsAdmin,
      vaultAsOther,
      vaultAsHarvester,
    };
  }

  async function deployAaveStrategy(
    vaultAddress: `0x${string}`,
    vaultTokenAddress: `0x${string}`,
  ) {
    const pool = await viem.deployContract("MockAaveV3Pool", [
      vaultTokenAddress,
    ]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultTokenAddress,
      pool.address,
      "Aave Mock USDT",
      "aMUSDT",
    ]);
    await pool.write.setAToken([aToken.address]);

    const implementation = await viem.deployContract("AaveV3Strategy");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vaultAddress,
        pool.address,
        vaultTokenAddress,
        aToken.address,
        "AAVE_V3_MUSDT",
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      addr(admin),
      initializeData,
    ]);
    const strategy = await viem.getContractAt("AaveV3Strategy", proxy.address);

    return { strategy, pool, aToken };
  }

  async function deploySghoStrategy(
    vaultAddress: `0x${string}`,
    vaultTokenAddress: `0x${string}`,
  ) {
    const gho = await viem.deployContract("MockERC20", ["GHO", "GHO", 18]);
    const sGho = await viem.deployContract("MockSgho", [gho.address]);
    const mockPool = await viem.deployContract("MockNonERC20");
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultTokenAddress,
      mockPool.address,
      "Aave Mock USDT",
      "aMUSDT",
    ]);
    const stataToken = await viem.deployContract("MockStataTokenV2", [
      aToken.address,
      vaultTokenAddress,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      stataToken.address,
    ]);

    const implementation = await viem.deployContract("SGHOStrategy");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vaultAddress,
        vaultTokenAddress,
        sGho.address,
        gsm.address,
        "SGHO_MUSDT",
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      addr(admin),
      initializeData,
    ]);
    const strategy = await viem.getContractAt("SGHOStrategy", proxy.address);

    return { strategy, gsm, gho, sGho, aToken, stataToken };
  }

  async function deployYieldRecipientTreasury(vaultAddress: `0x${string}`) {
    const treasury = await viem.deployContract("YieldRecipientTreasury", [
      addr(admin),
    ]);
    await treasury.write.setAuthorizedVault([vaultAddress, true]);
    return treasury;
  }

  it("tracks cost basis and harvests strategy yield to treasury", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      400_000n,
    );

    await stratA.write.setAssets([token.address, 450_000n]);
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      50_000n,
    );

    const treasury = (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await token.read.balanceOf([treasury])) as bigint;

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      stratA.address,
      30_000n,
      30_000n,
    ]);

    const treasuryAfter = (await token.read.balanceOf([treasury])) as bigint;
    assert.equal(treasuryAfter - treasuryBefore, 30_000n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      400_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      20_000n,
    );
  });

  it("allows yield harvesters and admins to harvest strategy yield", async function () {
    const {
      vault,
      vaultAsAllocator,
      vaultAsHarvester,
      vaultAsOther,
      token,
      stratA,
    } = await deployBase();

    await vault.write.grantRole([
      await vault.read.YIELD_HARVESTER_ROLE(),
      addr(harvester),
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);
    await stratA.write.setAssets([token.address, 450_000n]);

    const treasury = (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await token.read.balanceOf([treasury])) as bigint;

    await vaultAsHarvester.write.harvestYieldFromStrategy([
      token.address,
      stratA.address,
      30_000n,
      30_000n,
    ]);

    const treasuryAfter = (await token.read.balanceOf([treasury])) as bigint;
    assert.equal(treasuryAfter - treasuryBefore, 30_000n);
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      20_000n,
    );

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        1n,
        0n,
      ]),
      vaultAsOther,
      "Unauthorized",
    );
  });

  it("harvests exact reported yield from Aave when residual dust is present", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();
    const { strategy, pool } = await deployAaveStrategy(
      vault.address,
      token.address,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100_000n,
    ]);
    await pool.write.accrueYield([strategy.address, 10_000n]);
    await token.write.mint([strategy.address, 1n], {
      account: other.account,
    });

    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      10_001n,
    );

    const treasury = (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await token.read.balanceOf([treasury])) as bigint;

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      strategy.address,
      10_001n,
      10_001n,
    ]);

    const treasuryAfter = (await token.read.balanceOf([treasury])) as bigint;
    assert.equal(treasuryAfter - treasuryBefore, 10_001n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      100_000n,
    );
    assert.equal(
      await strategy.read.strategyExposure([token.address]),
      100_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      0n,
    );
  });

  it("reduces cost basis on bounded deallocation satisfied entirely from residual dust", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { strategy, aToken } = await deployAaveStrategy(
      vault.address,
      token.address,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100_000n,
    ]);
    await token.write.mint([strategy.address, 5n], {
      account: other.account,
    });

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      strategy.address,
      3n,
    ]);

    assert.equal(await token.read.balanceOf([vault.address]), 1_900_003n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 100_000n);
    assert.equal(await token.read.balanceOf([strategy.address]), 2n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      99_997n,
    );
    assert.equal(
      await strategy.read.strategyExposure([token.address]),
      100_002n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      5n,
    );
  });

  it("uses measured allocation spend for cost basis and harvest math when strategy under-pulls", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await stratA.write.setAllocatePullAmount([token.address, 300_000n]);
    const hash = await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const allocationEvent = expectEventOnce(
      receipt,
      vault,
      "VaultTokenAllocatedToStrategy",
    );
    assert.equal(allocationEvent.amount, 400_000n);

    assert.equal(allocationEvent.invested, 300_000n);
    assert.equal(allocationEvent.fee, 0n);

    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      300_000n,
    );

    await stratA.write.setAssets([token.address, 360_000n]);
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      60_000n,
    );
  });

  it("keeps cost basis at zero and emits mismatch telemetry when allocation spends nothing", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await stratA.write.setAllocatePullAmount([token.address, 0n]);
    const hash = await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const allocationEvent = expectEventOnce(
      receipt,
      vault,
      "VaultTokenAllocatedToStrategy",
    );
    assert.equal(allocationEvent.amount, 400_000n);

    assert.equal(allocationEvent.invested, 0n);
    assert.equal(allocationEvent.fee, 0n);

    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      0n,
    );
    assert.equal(await stratA.read.strategyExposure([token.address]), 0n);
  });

  it("enforces harvest bounds, slippage guard, and pause gating", async function () {
    const { vaultAsAllocator, vaultAsAdmin, vaultAsPauser, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      300_000n,
    ]);
    await stratA.write.setAssets([token.address, 320_000n]);

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        25_000n,
        0n,
      ]),
      vaultAsAdmin,
      "YieldNotAvailable",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        20_000n,
        21_000n,
      ]),
      vaultAsAdmin,
      "SlippageExceeded",
    );

    await vaultAsPauser.write.pause();
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        1n,
        0n,
      ]),
      vaultAsAdmin,
      "Paused",
    );
  });

  it("uses strategy exposure (not reporting components) for harvestable yield", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);

    await stratA.write.setComponents([
      token.address,
      [token.address],
      [10_000n],
    ]);
    await stratA.write.setExposure([token.address, 240_000n]);

    const breakdown = await vault.read.strategyPositionBreakdown([
      token.address,
      stratA.address,
    ]);
    assert.equal(breakdown.length, 1);
    assert.equal(breakdown[0].amount, 10_000n);

    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      40_000n,
    );
  });

  it("uses InvalidStrategyExposureRead for exposure-read failures in harvest paths", async function () {
    const { vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      100_000n,
    ]);
    await stratA.write.setRevertAssets([token.address, true]);

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.read.harvestableYield([token.address, stratA.address]),
      vaultAsAdmin,
      "InvalidStrategyExposureRead",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        1n,
        0n,
      ]),
      vaultAsAdmin,
      "InvalidStrategyExposureRead",
    );
  });

  it("unwraps wrapped-native harvest to native ETH and pays treasury in ETH", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const forwardingTreasury = await viem.deployContract(
      "TestForwardingNativeTreasury",
      [addr(other)],
    );
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault, 0n);
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      forwardingTreasury.address,
      minDelay,
    );

    const treasuryBefore = await publicClient.getBalance({
      address: addr(other),
    });
    const hash = await vaultAsAdmin.write.harvestYieldFromStrategy([
      wrappedNative.address,
      wethStrategy.address,
      30_000n,
      30_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = await publicClient.getBalance({
      address: addr(other),
    });
    assert.equal(treasuryAfter - treasuryBefore, 30_000n);
    assert.equal(await wrappedNative.read.balanceOf([addr(other)]), 0n);

    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    assert.equal(
      (harvested.vaultToken as string).toLowerCase(),
      wrappedNative.address.toLowerCase(),
    );
    assert.equal(
      (harvested.strategy as string).toLowerCase(),
      wethStrategy.address.toLowerCase(),
    );
    assert.equal(harvested.requested, 30_000n);
    assert.equal(harvested.received, 30_000n);
  });

  it("counts successful native harvest payout even when treasury forwards ETH onward", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const forwardingTreasury = await viem.deployContract(
      "TestForwardingNativeTreasury",
      [addr(other)],
    );
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault, 0n);
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      forwardingTreasury.address,
      minDelay,
    );

    const downstreamBefore = await publicClient.getBalance({
      address: addr(other),
    });
    const treasuryBefore = await publicClient.getBalance({
      address: forwardingTreasury.address,
    });

    const hash = await vaultAsAdmin.write.harvestYieldFromStrategy([
      wrappedNative.address,
      wethStrategy.address,
      30_000n,
      30_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const downstreamAfter = await publicClient.getBalance({
      address: addr(other),
    });
    const treasuryAfter = await publicClient.getBalance({
      address: forwardingTreasury.address,
    });

    assert.equal(downstreamAfter - downstreamBefore, 30_000n);
    assert.equal(treasuryAfter - treasuryBefore, 0n);

    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    assert.equal(harvested.requested, 30_000n);
    assert.equal(harvested.received, 30_000n);
  });

  it("rejects switching wrapped-native yield recipient to a treasury that cannot receive ETH", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const nonPayableTreasury = await viem.deployContract(
      "TestNonPayableTreasury",
    );
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault, 0n);
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      nonPayableTreasury.address,
      minDelay,
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        wrappedNative.address,
        wethStrategy.address,
        50_000n,
        50_000n,
      ]),
      vault,
      "NativeTransferFailed",
    );
  });

  it("enforces minReceived on wrapped-native harvest using treasury native ETH delta", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const forwardingTreasury = await viem.deployContract(
      "TestForwardingNativeTreasury",
      [addr(other)],
    );
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault, 0n);
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      forwardingTreasury.address,
      minDelay,
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        wrappedNative.address,
        wethStrategy.address,
        30_000n,
        30_001n,
      ]),
      vaultAsAdmin,
      "SlippageExceeded",
    );
  });

  it("blocks treasury-side reentrancy during wrapped-native harvest payout", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const reentrantTreasury = await viem.deployContract(
      "TestReentrantNativeTreasury",
      [vault.address],
    );
    const adminRole = await vault.read.VAULT_ADMIN_ROLE();
    await vault.write.grantRole([adminRole, reentrantTreasury.address]);
    const attackCalldata = encodeFunctionData({
      abi: vault.abi as any,
      functionName: "harvestYieldFromStrategy",
      args: [wrappedNative.address, wethStrategy.address, 1n, 0n],
    });
    await reentrantTreasury.write.configureReentry([attackCalldata]);

    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault, 0n);
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      reentrantTreasury.address,
      minDelay,
    );

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      wrappedNative.address,
      wethStrategy.address,
      30_000n,
      30_000n,
    ]);

    assert.equal(await reentrantTreasury.read.attemptedReentry(), true);
    assert.equal(await reentrantTreasury.read.reentrySucceeded(), false);

    const revertData =
      (await reentrantTreasury.read.lastRevertData()) as string;
    const expectedSelector = keccak256(
      stringToHex("ReentrancyGuardReentrantCall()"),
    ).slice(0, 10);
    assert.equal(revertData.slice(0, 10).toLowerCase(), expectedSelector);
  });

  it("reverts harvest when measured withdrawn amount exceeds pre-read harvestable yield", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();

    const edgeStrategy = await viem.deployContract("MockHarvestEdgeStrategy", [
      vault.address,
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      edgeStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      edgeStrategy.address,
      100_000n,
    ]);
    await edgeStrategy.write.setExposure([token.address, 110_000n]);
    await edgeStrategy.write.setDeallocateBonus([token.address, 1n]);

    assert.equal(
      await vault.read.harvestableYield([token.address, edgeStrategy.address]),
      10_000n,
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        edgeStrategy.address,
        10_000n,
        0n,
      ]),
      vaultAsAdmin,
      "YieldNotAvailable",
    );
  });

  it("does not auto-write-down cost basis when harvest leaves exposure below tracked cost basis", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();

    const edgeStrategy = await viem.deployContract("MockHarvestEdgeStrategy", [
      vault.address,
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      edgeStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      edgeStrategy.address,
      400_000n,
    ]);
    await edgeStrategy.write.setExposure([token.address, 420_000n]);

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      edgeStrategy.address,
      20_000n,
      20_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, edgeStrategy.address]),
      400_000n,
    );
    assert.equal(
      await edgeStrategy.read.strategyExposure([token.address]),
      400_000n,
    );
  });

  it("supports sequential harvests without changing tracked cost basis", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      300_000n,
    ]);
    await stratA.write.setAssets([token.address, 360_000n]);

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      stratA.address,
      20_000n,
      20_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      300_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      40_000n,
    );

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      stratA.address,
      30_000n,
      30_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      300_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      10_000n,
    );
  });

  it("keeps declared TVL tokens tracked after harvest payout until the strategy pair is removed", async function () {
    const {
      vault,
      vaultAsAdmin,
      token: grvtBridgeProxyFeeToken,
    } = await deployBase();

    const token = await viem.deployContract("MockERC20", [
      "HarvestToken",
      "HVT",
      6,
    ]);
    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "HARVEST_ONLY",
    ]);

    await vault.write.setVaultTokenConfig([token.address, { supported: true }]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    // Seed strategy-held vault token without increasing tracked cost basis;
    // this models yield-only harvestable balance.
    await token.write.mint([strategy.address, 50_000n]);
    await strategy.write.setAssets([token.address, 50_000n]);

    // Disable token support while exposure still exists; token remains tracked.
    await vault.write.setVaultTokenConfig([
      token.address,
      { supported: false },
    ]);
    assert.equal(await vault.read.isTrackedTvlToken([token.address]), true);

    const treasury = (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await token.read.balanceOf([treasury])) as bigint;

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      strategy.address,
      50_000n,
      50_000n,
    ]);

    const treasuryAfter = (await token.read.balanceOf([treasury])) as bigint;
    assert.equal(treasuryAfter - treasuryBefore, 50_000n);

    // Post-payout sync clears direct idle tracking, but the token remains tracked while the
    // active strategy pair still declares it in the cached TVL-token list.
    assert.equal(await vault.read.isTrackedTvlToken([token.address]), true);
    assert.equal(
      await vault.read.isSupportedVaultToken([token.address]),
      false,
    );
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await strategy.read.strategyExposure([token.address]), 0n);

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);
    assert.equal(await vault.read.isTrackedTvlToken([token.address]), false);

    // Sanity check base fixture token stays unaffected.
    assert.equal(
      await vault.read.isTrackedTvlToken([grvtBridgeProxyFeeToken.address]),
      true,
    );
  });

  it("updates treasury via configured timelock, not direct admin", async function () {
    const { vault, vaultAsAdmin, vaultAsOther } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const newYieldRecipient = await viem.deployContract(
      "TestForwardingNativeTreasury",
      [addr(other)],
    );

    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsOther, addr(other)),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "Unauthorized",
    );

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      newYieldRecipient.address,
      minDelay,
    );

    assert.equal(
      ((await vault.read.yieldRecipient()) as `0x${string}`).toLowerCase(),
      newYieldRecipient.address.toLowerCase(),
    );
  });

  it("enforces RBAC on treasury and harvest admin controls", async function () {
    const { vault, vaultAsAdmin, vaultAsOther, token, stratA } =
      await deployBase();

    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsOther, addr(other)),
      vaultAsOther,
      "YieldRecipientTimelockControllerNotSet",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setYieldRecipientTimelockController([addr(other)]),
      vaultAsOther,
      "Unauthorized",
    );

    await configureYieldRecipientTimelockController(vault);
    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsOther, addr(other)),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        1n,
        0n,
      ]),
      vaultAsOther,
      "Unauthorized",
    );
  });

  it("validates treasury-set edge cases", async function () {
    const { vault, vaultAsAdmin } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setYieldRecipientTimelockController([zeroAddress]),
      vaultAsAdmin,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setYieldRecipientTimelockController([addr(other)]),
      vaultAsAdmin,
      "InvalidParam",
    );

    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "YieldRecipientTimelockControllerNotSet",
    );

    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setYieldRecipientTimelockController([
        timelock.address,
      ]),
      vaultAsAdmin,
      "InvalidParam",
    );
    const currentTreasury =
      (await vault.read.yieldRecipient()) as `0x${string}`;

    await assert.rejects(
      executeSetYieldRecipientViaTimelock(
        vault,
        timelock,
        zeroAddress,
        minDelay,
      ),
    );
    await assert.rejects(
      executeSetYieldRecipientViaTimelock(
        vault,
        timelock,
        currentTreasury,
        minDelay,
      ),
    );
    await assert.rejects(
      executeSetYieldRecipientViaTimelock(
        vault,
        timelock,
        vault.address,
        minDelay,
      ),
    );
  });

  it("validates harvest input constraints and withdrawable-strategy checks", async function () {
    const { vault, vaultAsAdmin, token, stratA } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    const inactive = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "INACTIVE",
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        inactive.address,
        1n,
        0n,
      ]),
      vaultAsAdmin,
      "StrategyNotWhitelisted",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        zeroAddress,
        stratA.address,
        1n,
        0n,
      ]),
      vaultAsAdmin,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        zeroAddress,
        1n,
        0n,
      ]),
      vaultAsAdmin,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.harvestYieldFromStrategy([
        token.address,
        stratA.address,
        0n,
        0n,
      ]),
      vaultAsAdmin,
      "InvalidParam",
    );
  });

  it("decreases cost basis on deallocate and deallocateAll", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      1_200_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      1_200_000n,
    );

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      1_000_000n,
    );

    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      0n,
    );
  });

  it("reimburses SGHO entry dust through vault policy when it stays within 0.01 bps", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, sGho } = await deploySghoStrategy(
      vault.address,
      token.address,
    );
    await token.write.mint([treasury.address, 1n]);

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await sGho.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);
    await token.write.mint([vault.address, 100_000_000n]);

    const vaultBalanceBefore = (await token.read.balanceOf([
      vault.address,
    ])) as bigint;
    const treasuryBalanceBefore = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100_000_000n,
    ]);

    const vaultBalanceAfter = (await token.read.balanceOf([
      vault.address,
    ])) as bigint;
    const treasuryBalanceAfter = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(vaultBalanceBefore - vaultBalanceAfter, 99_999_999n);
    assert.equal(treasuryBalanceBefore - treasuryBalanceAfter, 1n);
    assert.equal(await strategy.read.totalExposure(), 99_999_999n);
    assert.equal(await strategy.read.withdrawableExposure(), 99_999_999n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      99_999_999n,
    );
  });

  it("models SGHO reimbursement as one shared token pool across lanes", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const laneOne = await deploySghoStrategy(vault.address, token.address);
    const laneTwo = await deploySghoStrategy(vault.address, token.address);
    await token.write.mint([treasury.address, 1n]);

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    for (const lane of [laneOne.strategy.address, laneTwo.strategy.address]) {
      await vault.write.setVaultTokenStrategyConfig([
        token.address,
        lane,
        { whitelisted: true, active: true, cap: 0n },
      ]);
      await vault.write.setStrategyPolicyConfig([
        token.address,
        lane,
        {
          entryCapHundredthBps: 1,
          exitCapHundredthBps: 1200,
          policyActive: true,
        },
      ]);
    }

    await laneOne.sGho.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);
    await laneTwo.sGho.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);
    await token.write.mint([vault.address, 200_000_000n]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      laneOne.strategy.address,
      100_000_000n,
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateVaultTokenToStrategy([
        token.address,
        laneTwo.strategy.address,
        100_000_000n,
      ]),
      treasury,
      "InsufficientTreasuryBalance",
    );

    assert.equal(await laneTwo.strategy.read.totalExposure(), 0n);
    assert.equal(
      await vault.read.strategyCostBasis([
        token.address,
        laneTwo.strategy.address,
      ]),
      0n,
    );
  });

  it("reverts SGHO allocation when entry loss exceeds the 0.01 bps vault cap", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, gsm, stataToken } = await deploySghoStrategy(
      vault.address,
      token.address,
    );

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await gsm.write.setAssetToGhoExecutionBps([stataToken.address, 9_999n]);
    await gsm.write.setAssetToGhoQuoteBps([stataToken.address, 9_999n]);
    await token.write.mint([vault.address, 100_000_000n]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateVaultTokenToStrategy([
        token.address,
        strategy.address,
        100_000_000n,
      ]),
      vaultAsAllocator,
      "FeeCapExceeded",
    );

    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      0n,
    );
  });

  it("allows SGHO tracked deallocation to return net proceeds and reimburse the exit fee", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, gsm, stataToken } = await deploySghoStrategy(
      vault.address,
      token.address,
    );
    await token.write.mint([treasury.address, 12n]);

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await gsm.write.setBurnFeeBps([stataToken.address, 12n]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      10_000n,
    ]);

    const vaultBalanceBeforeDeallocate = (await token.read.balanceOf([
      vault.address,
    ])) as bigint;
    const treasuryBalanceBefore = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      strategy.address,
      10_000n,
    ]);

    const vaultBalanceAfterDeallocate = (await token.read.balanceOf([
      vault.address,
    ])) as bigint;
    const treasuryBalanceAfter = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(
      vaultBalanceAfterDeallocate - vaultBalanceBeforeDeallocate,
      10_000n,
    );
    assert.equal(treasuryBalanceBefore - treasuryBalanceAfter, 12n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      0n,
    );
  });

  it("realizes SGHO tracked impairment as loss instead of reimbursing it as fee", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, sGho } = await deploySghoStrategy(
      vault.address,
      token.address,
    );

    await token.write.mint([treasury.address, 12n]);

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      10_000n,
    ]);

    await sGho.write.setAssetsPerShareWad([998_800_000_000_000_000n]);

    assert.equal(await strategy.read.totalExposure(), 9_988n);
    assert.equal(await strategy.read.withdrawableExposure(), 9_988n);

    const vaultBalanceBeforeDeallocate = (await token.read.balanceOf([
      vault.address,
    ])) as bigint;
    const treasuryBalanceBefore = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      strategy.address,
      10_000n,
    ]);

    const vaultBalanceAfterDeallocate = (await token.read.balanceOf([
      vault.address,
    ])) as bigint;
    const treasuryBalanceAfter = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(
      vaultBalanceAfterDeallocate - vaultBalanceBeforeDeallocate,
      9_988n,
    );
    assert.equal(treasuryBalanceAfter, treasuryBalanceBefore);
    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      0n,
    );
  });

  it("reverts SGHO tracked deallocation when liquidity is below economic recoverable principal", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, sGho } = await deploySghoStrategy(
      vault.address,
      token.address,
    );

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      10_000n,
    ]);

    await sGho.write.setAssetsPerShareWad([998_800_000_000_000_000n]);
    await sGho.write.setWithdrawalLimit([9_980n]);

    assert.equal(await strategy.read.totalExposure(), 9_988n);
    assert.equal(await strategy.read.withdrawableExposure(), 9_980n);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
        token.address,
        strategy.address,
        10_000n,
      ]),
      vaultAsAllocator,
      "InsufficientWithdrawableStrategyExposure",
    );

    assert.equal(await token.read.balanceOf([vault.address]), 1_990_000n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      10_000n,
    );
  });

  it("reverts SGHO full unwind when liquidity is below economic recoverable principal", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, gsm, stataToken, sGho } = await deploySghoStrategy(
      vault.address,
      token.address,
    );
    await token.write.mint([treasury.address, 12n]);

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await gsm.write.setBurnFeeBps([stataToken.address, 12n]);
    await sGho.write.setWithdrawalLimit([9_990n]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      10_000n,
    ]);

    assert.equal(await strategy.read.totalExposure(), 10_000n);
    assert.equal(await strategy.read.withdrawableExposure(), 9_990n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      10_000n,
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
        token.address,
        strategy.address,
      ]),
      vaultAsAllocator,
      "InsufficientWithdrawableStrategyExposure",
    );

    assert.equal(await token.read.balanceOf([vault.address]), 1_990_000n);
    assert.equal(await token.read.balanceOf([treasury.address]), 12n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      10_000n,
    );
  });

  it("harvests SGHO residual yield without requesting reimbursement from treasury", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);
    const treasury = await deployYieldRecipientTreasury(vault.address);
    const { strategy, gsm, stataToken, sGho } = await deploySghoStrategy(
      vault.address,
      token.address,
    );

    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      treasury.address,
      minDelay,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: true, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 1,
        exitCapHundredthBps: 1200,
        policyActive: true,
      },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100_000n,
    ]);

    await gsm.write.setBurnFeeBps([stataToken.address, 12n]);
    await sGho.write.setAssetsPerShareWad([1_100_000_000_000_000_000n]);
    await sGho.write.mintBacking([10_000n]);

    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      10_000n,
    );

    const treasuryBefore = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      strategy.address,
      10_000n,
      10_000n,
    ]);

    const treasuryAfter = (await token.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, 10_000n);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      100_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      0n,
    );
  });

  it("emits new treasury and harvest events with expected args", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();
    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(vault);

    const allocHash = await vaultAsAllocator.write.allocateVaultTokenToStrategy(
      [token.address, stratA.address, 200_000n],
    );
    await publicClient.waitForTransactionReceipt({
      hash: allocHash,
    });

    await stratA.write.setAssets([token.address, 230_000n]);
    const treasuryBefore = (await vault.read.yieldRecipient()) as `0x${string}`;
    const harvestHash = await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      stratA.address,
      10_000n,
      10_000n,
    ]);
    const harvestReceipt = await publicClient.waitForTransactionReceipt({
      hash: harvestHash,
    });
    const harvestEvent = expectEventOnce(
      harvestReceipt,
      vault,
      "YieldHarvested",
    );
    assert.equal(
      (harvestEvent.vaultToken as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (harvestEvent.strategy as string).toLowerCase(),
      stratA.address.toLowerCase(),
    );
    assert.equal(
      (harvestEvent.yieldRecipient as string).toLowerCase(),
      treasuryBefore.toLowerCase(),
    );
    assert.equal(harvestEvent.requested, 10_000n);
    assert.equal(harvestEvent.received, 10_000n);

    const newYieldRecipient = await viem.deployContract(
      "TestForwardingNativeTreasury",
      [addr(other)],
    );
    const setHash = await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      newYieldRecipient.address,
      minDelay,
    );
    const setReceipt = await publicClient.waitForTransactionReceipt({
      hash: setHash,
    });
    const updatedEvent = expectEventOnce(
      setReceipt,
      vault,
      "YieldRecipientUpdated",
    );
    assert.equal(
      (updatedEvent.previousYieldRecipient as string).toLowerCase(),
      treasuryBefore.toLowerCase(),
    );
    assert.equal(
      (updatedEvent.newYieldRecipient as string).toLowerCase(),
      newYieldRecipient.address.toLowerCase(),
    );
  });

  it("uses measured harvest delta when strategy over-reports and emits mismatch telemetry", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();
    const overreporting = await viem.deployContract(
      "MockOverreportingStrategy",
      [vault.address],
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      overreporting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      overreporting.address,
      200_000n,
    ]);
    await overreporting.write.setAssets([token.address, 230_000n]);
    await overreporting.write.setReportExtra([5_000n]);

    const treasury = (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await token.read.balanceOf([treasury])) as bigint;

    const hash = await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      overreporting.address,
      10_000n,
      10_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = (await token.read.balanceOf([treasury])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, 10_000n);

    const mismatch = expectEventOnce(
      receipt,
      vault,
      "StrategyReportedReceivedMismatch",
    );
    assert.equal(mismatch.reported, 15_000n);
    assert.equal(mismatch.measured, 10_000n);

    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    assert.equal(harvested.requested, 10_000n);
    assert.equal(harvested.received, 10_000n);
  });

  it("supports standardized delayed treasury updates via OZ TimelockController", async function () {
    const { vault } = await deployBase();
    const minDelay = 2n;
    const timelock = await viem.deployContract("TestTimelockController", [
      minDelay,
      [addr(admin)],
      [addr(admin)],
      addr(admin),
    ]);
    const newYieldRecipient = await viem.deployContract(
      "TestForwardingNativeTreasury",
      [addr(other)],
    );

    await vault.write.setYieldRecipientTimelockController([timelock.address]);

    const data = encodeFunctionData({
      abi: vault.abi as any,
      functionName: "setYieldRecipient",
      args: [newYieldRecipient.address],
    });
    const zeroHash =
      "0x0000000000000000000000000000000000000000000000000000000000000000";

    await timelock.write.schedule([
      vault.address,
      0n,
      data,
      zeroHash,
      zeroHash,
      minDelay,
    ]);

    await assert.rejects(
      timelock.write.execute([vault.address, 0n, data, zeroHash, zeroHash]),
    );

    await increaseTimeAndMine(Number(minDelay));
    await timelock.write.execute([vault.address, 0n, data, zeroHash, zeroHash]);

    assert.equal(
      ((await vault.read.yieldRecipient()) as `0x${string}`).toLowerCase(),
      newYieldRecipient.address.toLowerCase(),
    );
  });

  it("caps cost-basis decrease at zero when received exceeds tracked cost basis", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();

    const edgeStrategy = await viem.deployContract("MockHarvestEdgeStrategy", [
      vault.address,
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      edgeStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      edgeStrategy.address,
      50_000n,
    ]);

    await edgeStrategy.write.setDeallocateBonus([token.address, 70_000n]);
    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      edgeStrategy.address,
      50_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, edgeStrategy.address]),
      0n,
    );
  });

  it("allows harvesting from withdraw-only strategies", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      300_000n,
    ]);
    await stratA.write.setAssets([token.address, 340_000n]);

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);
    const cfg = (await vault.read.getVaultTokenStrategyConfig([
      token.address,
      stratA.address,
    ])) as { whitelisted: boolean; active: boolean; cap: bigint };
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, true);

    const treasury = (await vault.read.yieldRecipient()) as `0x${string}`;
    const before = (await token.read.balanceOf([treasury])) as bigint;
    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      stratA.address,
      20_000n,
      20_000n,
    ]);
    const after = (await token.read.balanceOf([treasury])) as bigint;

    assert.equal(after - before, 20_000n);
  });

  it("resets cost basis to zero when strategy is removed from registry", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      200_000n,
    );

    await stratA.write.setAssets([token.address, 0n]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);

    assert.equal(
      await vault.read.strategyCostBasis([token.address, stratA.address]),
      0n,
    );
    const list = (await vault.read.getVaultTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(
      list
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(stratA.address.toLowerCase()),
      false,
    );
  });
});
