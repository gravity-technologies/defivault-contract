import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { expectEventCount, expectEventOnce } from "../helpers/events.js";
import {
  configureYieldRecipientTimelockController,
  executeSetYieldRecipientViaTimelock,
} from "../helpers/timelock.js";
import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault GHO reimbursement flows", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) throw new Error("wallet has no account");
    return wallet.account.address;
  }

  function ceilGrossForNet(amountOut: bigint, feeBps: bigint) {
    const bpsScale = 10_000n;
    return (
      (amountOut * bpsScale + (bpsScale - feeBps - 1n)) / (bpsScale - feeBps)
    );
  }

  function feeForGross(amountIn: bigint, feeBps: bigint) {
    return (amountIn * feeBps) / 10_000n;
  }

  async function deploySystem({
    burnFeeBps = 7n,
    yieldRecipient,
  }: {
    burnFeeBps?: bigint;
    yieldRecipient?: `0x${string}`;
  } = {}) {
    const treasury = await viem.deployContract("MockWithdrawalFeeTreasury");
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const { vaultImplementation: vaultImpl } =
      await deployVaultImplementation(viem);
    const configuredYieldRecipient = yieldRecipient ?? treasury.address;
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
        configuredYieldRecipient,
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
    await treasury.write.setAuthorizedVault([vault.address, true]);

    const vaultToken = await viem.deployContract("MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    const gho = await viem.deployContract("MockERC20", ["GHO", "GHO", 18]);
    const stkGho = await viem.deployContract("MockERC20", [
      "Staked GHO",
      "stkGHO",
      18,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [gho.address]);
    const staking = await viem.deployContract("MockStkGhoStaking", [
      gho.address,
      stkGho.address,
    ]);
    await gsm.write.setBurnFeeBps([vaultToken.address, burnFeeBps]);

    const strategyImpl = await viem.deployContract("GsmStkGhoStrategy");
    const strategyInitData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [
        vault.address,
        vaultToken.address,
        gho.address,
        stkGho.address,
        gsm.address,
        staking.address,
        "GSM_STKGHO_USDC",
      ],
    });
    const strategyProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [strategyImpl.address, addr(admin), strategyInitData],
    );
    const strategy = await viem.getContractAt(
      "GsmStkGhoStrategy",
      strategyProxy.address,
    );

    await vaultToken.write.mint([vault.address, 200_000n]);
    await vaultToken.write.mint([treasury.address, 50_000n]);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.grantRole([
      await vault.read.REBALANCER_ROLE(),
      addr(rebalancer),
    ]);
    await vault.write.grantRole([await vault.read.PAUSER_ROLE(), addr(pauser)]);

    await vault.write.setVaultTokenConfig([
      vaultToken.address,
      { supported: true },
    ]);
    await vault.write.setBridgeableVaultToken([vaultToken.address, true]);
    await vault.write.setVaultTokenStrategyConfig([
      vaultToken.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
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

    return {
      bridge,
      treasury,
      vault,
      vaultToken,
      stkGho,
      gsm,
      staking,
      strategy,
      vaultAsAllocator,
      vaultAsRebalancer,
      configuredYieldRecipient,
      burnFeeBps,
    };
  }

  it("settles reimbursement after tracked exits with explicit tracked-leg accounting", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    const idleBefore = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    const hash = await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      50_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(idleAfter - idleBefore, 50_000n);
    assert.equal(treasuryBefore - treasuryAfter, 35n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      50_000n,
    );

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    assert.equal(deallocated.trackedReceived, 49_965n);
    assert.equal(deallocated.residualReceived, 0n);

    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, 35n);
    assert.equal(settled.cappedFee, 35n);
    assert.equal(settled.reimbursed, 35n);
    assert.equal(
      await treasury.read.reimbursementEnabled([
        strategy.address,
        vaultToken.address,
      ]),
      true,
    );
    assert.equal(
      await treasury.read.reimbursementBudget([
        strategy.address,
        vaultToken.address,
      ]),
      9_965n,
    );
  });

  it("tracked exits ignore idle residual vault-token balance and reimburse the tracked shortfall", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await vaultToken.write.mint([strategy.address, 10_000n], {
      account: other.account,
    });

    const idleBefore = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    const hash = await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      50_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(idleAfter - idleBefore, 50_000n);
    assert.equal(treasuryBefore - treasuryAfter, 35n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      50_000n,
    );

    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, 35n);
    assert.equal(settled.cappedFee, 35n);
    assert.equal(settled.reimbursed, 35n);
  });

  it("settles the final tracked exit without reverting and clears cost basis", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    const idleBefore = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;
    const hash =
      await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
      ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(idleAfter - idleBefore, 100_000n);
    assert.equal(treasuryBefore - treasuryAfter, 70n);

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    assert.equal(deallocated.trackedReceived, 99_930n);
    assert.equal(deallocated.residualReceived, 0n);
    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, 70n);
    assert.equal(settled.cappedFee, 70n);
    assert.equal(settled.reimbursed, 70n);
  });

  it("splits oversized exits into reimbursing tracked and non-reimbursing residual legs", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await stkGho.write.mint([strategy.address, 20_000n], {
      account: other.account,
    });

    const idleBefore = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    const hash = await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      110_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(idleAfter - idleBefore, 110_000n);
    assert.equal(treasuryBefore - treasuryAfter, 70n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    assert.equal(deallocated.trackedReceived, 99_930n);
    assert.equal(deallocated.residualReceived, 10_000n);

    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, 70n);
    assert.equal(settled.cappedFee, 70n);
    assert.equal(settled.reimbursed, 70n);
  });

  it("caps reimbursement at 20 bps of the tracked leg", async function () {
    const {
      treasury,
      vault,
      vaultToken,
      strategy,
      vaultAsAllocator,
      burnFeeBps,
    } = await deploySystem({
      burnFeeBps: 30n,
    });

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    const uncappedFee = feeForGross(
      ceilGrossForNet(50_000n, burnFeeBps),
      burnFeeBps,
    );
    const cappedFee = (50_000n * 20n) / 10_000n;
    const idleBefore = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    const hash = await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      50_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(uncappedFee > cappedFee, true);
    assert.equal(idleAfter - idleBefore, 49_950n);
    assert.equal(treasuryBefore - treasuryAfter, 100n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      50_050n,
    );

    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, uncappedFee);
    assert.equal(settled.cappedFee, cappedFee);
    assert.equal(settled.reimbursed, cappedFee);
  });

  it("invariant: residual yield must not erase tracked shortfall left above the reimbursement cap", async function () {
    const request = 100_000n;
    const extraYield = 200n;

    const {
      treasury: baselineTreasury,
      vault: baselineVault,
      vaultToken: baselineVaultToken,
      strategy: baselineStrategy,
      vaultAsAllocator: baselineAllocator,
    } = await deploySystem({ burnFeeBps: 30n });
    await baselineTreasury.write.setReimbursementConfig([
      baselineStrategy.address,
      baselineVaultToken.address,
      true,
      10_000n,
    ]);
    await baselineAllocator.write.allocateVaultTokenToStrategy([
      baselineVaultToken.address,
      baselineStrategy.address,
      request,
    ]);

    await baselineAllocator.write.deallocateVaultTokenFromStrategy([
      baselineVaultToken.address,
      baselineStrategy.address,
      request,
    ]);

    const baselineCostBasis = (await baselineVault.read.strategyCostBasis([
      baselineVaultToken.address,
      baselineStrategy.address,
    ])) as bigint;

    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem({ burnFeeBps: 30n });
    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      request,
    ]);
    await stkGho.write.mint([strategy.address, extraYield], {
      account: other.account,
    });

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      request,
    ]);

    const yieldAssistedCostBasis = (await vault.read.strategyCostBasis([
      vaultToken.address,
      strategy.address,
    ])) as bigint;

    assert.equal(baselineCostBasis > 0n, true);
    assert.equal(
      yieldAssistedCostBasis,
      baselineCostBasis,
      "residual yield should not reduce tracked cost basis beyond the capped reimbursement path",
    );
  });

  it("reverts tracked exits when exact reimbursement cannot be settled", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await treasury.write.setShouldRevert([true]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
      ]),
      treasury,
      "ForcedRevert",
    );
  });

  it("reverts tracked exits when treasury returns zero instead of the exact reimbursement", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await treasury.write.setShortPayBps([vaultToken.address, 1n]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
      ]),
      vault,
      "InvalidParam",
    );
  });

  it("settles reimbursement on paused defensive exits", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await vault.write.pause();

    const hash =
      await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
      ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, 70n);
    assert.equal(settled.cappedFee, 70n);
    assert.equal(settled.reimbursed, 70n);
  });

  it("settles reimbursement during emergency bridge unwind", async function () {
    const {
      bridge,
      treasury,
      vault,
      vaultToken,
      strategy,
      vaultAsAllocator,
      vaultAsRebalancer,
    } = await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;
    const hash = await vaultAsRebalancer.write.emergencyErc20ToL2([
      vaultToken.address,
      200_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(await bridge.read.lastAmount(), 200_000n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(treasuryBefore - treasuryAfter, 70n);

    const settled = expectEventOnce(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
    );
    assert.equal(settled.reportedFee, 70n);
    assert.equal(settled.cappedFee, 70n);
    assert.equal(settled.reimbursed, 70n);
  });

  it("emergency unwind still recovers already-liquid residual vault token when the tracked GSM leg fails", async function () {
    const {
      bridge,
      vault,
      vaultToken,
      gsm,
      strategy,
      vaultAsAllocator,
      vaultAsRebalancer,
    } = await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await vaultToken.write.mint([strategy.address, 10_000n], {
      account: other.account,
    });
    await gsm.write.setGhoToAssetExecutionBps([vaultToken.address, 9_999n]);

    const hash = await vaultAsRebalancer.write.emergencyErc20ToL2([
      vaultToken.address,
      105_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(await bridge.read.lastAmount(), 105_000n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 5_000n);

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    assert.equal(deallocated.trackedReceived, 0n);
    assert.equal(deallocated.residualReceived, 5_000n);
  });

  it("keeps residual value harvestable after a capped principal loss leaves cost basis behind", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem({ burnFeeBps: 30n });

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
    ]);

    assert.equal(
      ((await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ])) as bigint) > 0n,
      true,
    );

    await stkGho.write.mint([strategy.address, 100n], {
      account: other.account,
    });

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.equal(harvestable, 100n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      harvestable,
    ]);
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, 100n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100n,
    );
  });

  it("treats positive stkGHO share-price drift as residual harvestable value", async function () {
    const { treasury, vault, vaultToken, staking, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await staking.write.setAssetsPerShareWad([1_200_000_000_000_000_000n]);

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.equal(harvestable, 19_986n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      harvestable,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, harvestable);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
    expectEventCount(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
      0,
    );
  });

  it("keeps harvest reimbursement-free even when treasury reimbursement is configured", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      true,
      10_000n,
    ]);
    await treasury.write.setShouldRevert([true]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await stkGho.write.mint([strategy.address, 20_000n], {
      account: other.account,
    });

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.equal(harvestable, 19_986n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      harvestable,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, harvestable);
    expectEventCount(
      receipt,
      vault,
      "StrategyWithdrawalFeeReimbursementSettled",
      0,
    );
    expectEventCount(receipt, treasury, "WithdrawalFeeReimbursed", 0);
  });

  it("rejects switching yieldRecipient to a non-treasury contract", async function () {
    const { vault } = await deploySystem();
    const incompatibleRecipient = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
    ]);

    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(viem, vault, addr(admin));

    await viem.assertions.revertWithCustomError(
      executeSetYieldRecipientViaTimelock(
        publicClient as any,
        vault,
        timelock,
        incompatibleRecipient.address,
        minDelay,
      ),
      vault,
      "IncompatibleYieldRecipientTreasury",
    );
  });

  it("allows switching yieldRecipient to another compatible treasury contract", async function () {
    const { vault } = await deploySystem();
    const replacementTreasury = await viem.deployContract(
      "MockWithdrawalFeeTreasury",
    );

    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(viem, vault, addr(admin));

    await executeSetYieldRecipientViaTimelock(
      publicClient as any,
      vault,
      timelock,
      replacementTreasury.address,
      minDelay,
    );

    assert.equal(
      ((await vault.read.yieldRecipient()) as string).toLowerCase(),
      replacementTreasury.address.toLowerCase(),
    );
  });
});
