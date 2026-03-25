import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";

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

  function proofHashFor(proofs: readonly `0x${string}`[]) {
    return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [proofs]));
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
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      vaultToken.address,
    ] as any);
    const staking = await viem.deployContract("MockStkGhoStaking", [
      gho.address,
      stkGho.address,
    ]);
    const rewardsDistributor = await viem.deployContract(
      "MockAngleRewardsDistributor",
      [stkGho.address],
    );
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
        rewardsDistributor.address,
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

    const configuredYieldRecipientIsTreasury =
      configuredYieldRecipient.toLowerCase() === treasury.address.toLowerCase();
    if (configuredYieldRecipientIsTreasury) {
      await treasury.write.setReimbursementConfig([
        strategy.address,
        vaultToken.address,
        10_000n,
      ]);
    }
    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 0,
        exitCapBps: 7,
        policyActive: true,
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

    return {
      bridge,
      treasury,
      vault,
      vaultToken,
      gho,
      stkGho,
      gsm,
      staking,
      rewardsDistributor,
      strategy,
      vaultAsAllocator,
      vaultAsRebalancer,
      configuredYieldRecipient,
      burnFeeBps,
    };
  }

  async function deployAaveV2Lane(
    vault: any,
    vaultToken: any,
    strategyName = "AAVE_V3_USDC_V2_TEST",
  ) {
    const pool = await viem.deployContract("MockAaveV3Pool", [
      vaultToken.address,
    ]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultToken.address,
      pool.address,
      "Aave USDC",
      "aUSDC",
    ]);
    await pool.write.setAToken([aToken.address]);

    const implementation = await viem.deployContract("AaveV3StrategyV2");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      addr(admin),
    ]);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.address,
        pool.address,
        vaultToken.address,
        aToken.address,
        strategyName,
      ],
    });
    const proxy = await viem.deployContract("TestBeaconProxy", [
      beacon.address,
      initializeData,
    ]);
    const strategy = await viem.getContractAt(
      "AaveV3StrategyV2",
      proxy.address,
    );

    await vault.write.setVaultTokenStrategyConfig([
      vaultToken.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 0,
        exitCapBps: 0,
        policyActive: true,
      },
    ]);

    return { pool, aToken, beacon, strategy };
  }

  it("settles reimbursement after tracked exits with explicit tracked-leg accounting", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

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

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    const settled = expectEventOnce(receipt, treasury, "FeeReimbursed");

    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(idleAfter - idleBefore, 50_000n);
    assert.equal(treasuryBefore - treasuryAfter, deallocated.fee);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      50_000n,
    );

    assert.equal(deallocated.requested, 50_000n);
    assert.equal(deallocated.received, 49_965n);
    assert.equal(deallocated.fee, 35n);
    assert.equal(deallocated.loss, 0n);
    assert.equal(settled.amount, deallocated.fee);
    assert.equal(
      await treasury.read.reimbursementBudget([
        strategy.address,
        vaultToken.address,
      ]),
      9_965n,
    );
  });

  it("reimburses GSM entry fees on allocation and records net deployed cost basis", async function () {
    const { treasury, vault, vaultToken, gsm, strategy, vaultAsAllocator } =
      await deploySystem();

    await gsm.write.setAssetToGhoExecutionBps([vaultToken.address, 9_999n]);
    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 10,
        exitCapBps: 7,
        policyActive: true,
      },
    ]);

    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;
    const hash = await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const allocated = expectEventOnce(receipt, treasury, "FeeReimbursed");
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(allocated.amount, 10n);
    assert.equal(treasuryBefore - treasuryAfter, 10n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      99_990n,
    );
    assert.equal(await strategy.read.totalExposure(), 99_990n);
  });

  it("does not reimburse zero-fee tracked flows on the Aave V2 lane", async function () {
    const { treasury, vault, vaultToken, vaultAsAllocator } =
      await deploySystem();
    const { strategy } = await deployAaveV2Lane(vault, vaultToken);

    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    const allocateHash =
      await vaultAsAllocator.write.allocateVaultTokenToStrategy([
        vaultToken.address,
        strategy.address,
        50_000n,
      ]);
    const allocateReceipt = await publicClient.waitForTransactionReceipt({
      hash: allocateHash,
    });
    expectEventCount(allocateReceipt, treasury, "FeeReimbursed", 0);

    const deallocateHash =
      await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
        20_000n,
      ]);
    const deallocateReceipt = await publicClient.waitForTransactionReceipt({
      hash: deallocateHash,
    });
    expectEventCount(deallocateReceipt, treasury, "FeeReimbursed", 0);

    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, 0n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      30_000n,
    );
  });

  it("reverts allocation when the zero-cap entry policy sees a non-zero mint fee", async function () {
    const { vault, vaultToken, strategy, gsm, vaultAsAllocator } =
      await deploySystem({ burnFeeBps: 0n });

    await gsm.write.setAssetToGhoExecutionBps([vaultToken.address, 9_999n]);
    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateVaultTokenToStrategy([
        vaultToken.address,
        strategy.address,
        100_000n,
      ]),
      vault,
      "FeeCapExceeded",
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(await strategy.read.totalExposure(), 0n);
  });

  it("tracked exits ignore idle residual vault-token balance and reimburse the tracked shortfall", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

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

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    const settled = expectEventOnce(receipt, treasury, "FeeReimbursed");

    const idleAfter = (await vault.read.idleTokenBalance([
      vaultToken.address,
    ])) as bigint;
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(idleAfter - idleBefore, 50_000n);
    assert.equal(treasuryBefore - treasuryAfter, deallocated.fee);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      50_000n,
    );

    assert.equal(settled.amount, deallocated.fee);
  });

  it("settles the final tracked exit without reverting and clears cost basis", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

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

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    const settled = expectEventOnce(receipt, treasury, "FeeReimbursed");
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
    assert.equal(treasuryBefore - treasuryAfter, deallocated.fee);
    assert.equal(deallocated.received, 99_930n);
    assert.equal(deallocated.fee, 70n);
    assert.equal(deallocated.loss, 0n);
    assert.equal(settled.amount, deallocated.fee);
  });

  it("reverts normal V2 exits above tracked outstanding even when residual exists", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await stkGho.write.mint([strategy.address, 20_000n], {
      account: other.account,
    });

    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
        110_000n,
      ]),
      vault,
      "InvalidParam",
    );

    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
    assert.equal(
      await vaultToken.read.balanceOf([treasury.address]),
      treasuryBefore,
    );
  });

  it("reverts tracked exits when the burn fee exceeds the exit cap", async function () {
    const { vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem({
        burnFeeBps: 30n,
      });

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
        50_000n,
      ]),
      vault,
      "FeeCapExceeded",
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
  });

  it("keeps fee-free direct residual harvestable when a tracked exit is blocked by cap", async function () {
    const { vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem({
        burnFeeBps: 30n,
      });

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await vaultToken.write.mint([strategy.address, 200n], {
      account: other.account,
    });

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
        100_000n,
      ]),
      vault,
      "FeeCapExceeded",
    );

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.equal(harvestable, 200n);

    const recipient = (await vault.read.yieldRecipient()) as `0x${string}`;
    const recipientBefore = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;
    await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    const recipientAfter = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;

    assert.equal(recipientAfter - recipientBefore, 200n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
  });

  it("reverts tracked exits when exact reimbursement cannot be settled", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
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
      "FeeReimbursementFailed",
    );
  });

  it("settles reimbursement on paused defensive exits", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deploySystem();

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
    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    const settled = expectEventOnce(receipt, treasury, "FeeReimbursed");

    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(deallocated.fee, 70n);
    assert.equal(settled.amount, deallocated.fee);
  });

  it("blocks allocation and harvest when policy is inactive but still allows tracked exits", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await stkGho.write.mint([strategy.address, 20_000n], {
      account: other.account,
    });

    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 0,
        exitCapBps: 7,
        policyActive: false,
      },
    ]);

    const deallocated = expectEventOnce(
      await publicClient.waitForTransactionReceipt({
        hash: await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
          vaultToken.address,
          strategy.address,
        ]),
      }),
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      20_000n,
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateVaultTokenToStrategy([
        vaultToken.address,
        strategy.address,
        1n,
      ]),
      vault,
      "V2StrategyPolicyInactive",
    );

    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;
    const harvestHash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      1n,
      1n,
    ]);
    const harvestReceipt = await publicClient.waitForTransactionReceipt({
      hash: harvestHash,
    });
    const harvested = expectEventOnce(harvestReceipt, vault, "YieldHarvested");
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(treasuryAfter - treasuryBefore, harvested.received);
    expectEventCount(harvestReceipt, treasury, "FeeReimbursed", 0);
    assert.equal(deallocated.fee, 70n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
  });

  it("recognizes impairment on deallocateAll when strategy exposure falls below cost basis", async function () {
    const { treasury, vault, vaultToken, staking, strategy, vaultAsAllocator } =
      await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await staking.write.setAssetsPerShareWad([900_000_000_000_000_000n]);

    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;
    const hash =
      await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
        vaultToken.address,
        strategy.address,
      ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const deallocated = expectEventOnce(
      receipt,
      vault,
      "VaultTokenDeallocatedFromStrategy",
    );
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;

    assert.equal(deallocated.requested, 2n ** 256n - 1n);
    assert.equal(deallocated.loss, 10_000n);
    assert.equal(treasuryBefore - treasuryAfter, deallocated.fee);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
  });

  it("allows final residual harvest after deallocateAll even when policy is inactive", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await stkGho.write.mint([strategy.address, 20_000n], {
      account: other.account,
    });
    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 0,
        exitCapBps: 7,
        policyActive: false,
      },
    ]);

    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
    ]);

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.equal(harvestable, 20_000n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(harvested.requested, harvestable);
    assert.equal(treasuryAfter - treasuryBefore, harvested.received);
    expectEventCount(receipt, treasury, "FeeReimbursed", 0);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
  });

  it("keeps claimed stkGHO harvestable through the residual path", async function () {
    const {
      treasury,
      vault,
      vaultToken,
      stkGho,
      strategy,
      rewardsDistributor,
      vaultAsAllocator,
    } = await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);

    const proofs = [
      "0x350b99a70072e399e62a77feb286a8ad54a3833a193d0d762da90eddb4691db1",
      "0xcdf8ba7595f375810391a20489ea8ca606e87985521ce651105318515416da45",
    ] as const;
    const claimable = 12_345n;
    await stkGho.write.mint([rewardsDistributor.address, claimable], {
      account: other.account,
    });
    await rewardsDistributor.write.setClaimable([
      strategy.address,
      stkGho.address,
      claimable,
      proofHashFor(proofs),
    ]);
    await strategy.write.claimStkGhoRewards([claimable, proofs], {
      account: other.account,
    });

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.equal(harvestable, 12_345n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(harvested.requested, harvestable);
    assert.equal(treasuryAfter - treasuryBefore, harvested.received);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
    expectEventCount(receipt, treasury, "FeeReimbursed", 0);
  });

  it("treats positive stkGHO share-price drift as residual harvestable value", async function () {
    const { treasury, vault, vaultToken, staking, strategy, vaultAsAllocator } =
      await deploySystem();

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
    assert.equal(harvestable, 20_000n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(harvested.requested, harvestable);
    assert.equal(treasuryAfter - treasuryBefore, harvested.received);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );
    expectEventCount(receipt, treasury, "FeeReimbursed", 0);
  });

  it("keeps tracked and residual value separate across repeated GHO exit and harvest cycles", async function () {
    const {
      vault,
      vaultToken,
      gho,
      stkGho,
      staking,
      strategy,
      vaultAsAllocator,
    } = await deploySystem();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      100_000n,
    );

    await staking.write.setAssetsPerShareWad([1_200_000_000_000_000_000n]);
    await vaultToken.write.mint([strategy.address, 3_000n], {
      account: other.account,
    });

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      40_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      60_000n,
    );

    let harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.ok(harvestable > 0n);

    const recipient = (await vault.read.yieldRecipient()) as `0x${string}`;
    const firstHarvest = harvestable / 2n;
    const recipientBeforeFirst = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;
    const firstHash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      firstHarvest,
      0n,
    ]);
    const firstReceipt = await publicClient.waitForTransactionReceipt({
      hash: firstHash,
    });
    const firstHarvested = expectEventOnce(
      firstReceipt,
      vault,
      "YieldHarvested",
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      60_000n,
    );
    assert.equal(
      (await vaultToken.read.balanceOf([recipient])) - recipientBeforeFirst,
      firstHarvested.received,
    );

    await stkGho.write.mint([strategy.address, 10_000n], {
      account: other.account,
    });
    await gho.write.mint([strategy.address, 5n], {
      account: other.account,
    });
    await staking.write.setAssetsPerShareWad([1_500_000_000_000_000_000n]);

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      20_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      40_000n,
    );

    harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    assert.ok(harvestable > 0n);

    const recipientBeforeSecond = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;
    const secondHash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    const secondReceipt = await publicClient.waitForTransactionReceipt({
      hash: secondHash,
    });
    const secondHarvested = expectEventOnce(
      secondReceipt,
      vault,
      "YieldHarvested",
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      40_000n,
    );
    assert.equal(
      (await vaultToken.read.balanceOf([recipient])) - recipientBeforeSecond,
      secondHarvested.received,
    );

    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );

    const finalHarvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    if (finalHarvestable != 0n) {
      const finalHash = await vault.write.harvestYieldFromStrategy([
        vaultToken.address,
        strategy.address,
        finalHarvestable,
        0n,
      ]);
      const finalReceipt = await publicClient.waitForTransactionReceipt({
        hash: finalHash,
      });
      expectEventOnce(finalReceipt, vault, "YieldHarvested");
    }

    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      0n,
    );
    assert.equal(await strategy.read.totalExposure(), 0n);
  });

  it("keeps harvest reimbursement-free even when treasury reimbursement is configured", async function () {
    const { treasury, vault, vaultToken, stkGho, strategy, vaultAsAllocator } =
      await deploySystem();

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
    assert.equal(harvestable, 20_000n);

    const treasuryRecipient =
      (await vault.read.yieldRecipient()) as `0x${string}`;
    const treasuryBefore = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;
    const hash = await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const harvested = expectEventOnce(receipt, vault, "YieldHarvested");
    const treasuryAfter = (await vaultToken.read.balanceOf([
      treasuryRecipient,
    ])) as bigint;

    assert.equal(harvested.requested, harvestable);
    assert.equal(treasuryAfter - treasuryBefore, harvested.received);
    expectEventCount(receipt, treasury, "FeeReimbursed", 0);
    expectEventCount(receipt, treasury, "FeeReimbursed", 0);
  });

  it("emits mismatch telemetry when a legacy strategy overreports received amount", async function () {
    const { vault, vaultToken, vaultAsAllocator } = await deploySystem();
    const overreporting = await viem.deployContract(
      "MockOverreportingStrategy",
      [vault.address],
    );

    await vault.write.setVaultTokenStrategyConfig([
      vaultToken.address,
      overreporting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      overreporting.address,
      100_000n,
    ]);
    await overreporting.write.setReportExtra([123n]);

    const hash = await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      overreporting.address,
      50_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const mismatch = expectEventOnce(
      receipt,
      vault,
      "StrategyReportedReceivedMismatch",
    );

    assert.equal(mismatch.reported, 50_123n);
    assert.equal(mismatch.measured, 50_000n);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        overreporting.address,
      ]),
      50_000n,
    );
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

  it("rejects switching yieldRecipient to a compatible treasury without vault authorization", async function () {
    const { vault } = await deploySystem();
    const replacementTreasury = await viem.deployContract(
      "MockWithdrawalFeeTreasury",
    );

    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(viem, vault, addr(admin));

    await viem.assertions.revertWithCustomError(
      executeSetYieldRecipientViaTimelock(
        publicClient as any,
        vault,
        timelock,
        replacementTreasury.address,
        minDelay,
      ),
      vault,
      "IncompatibleYieldRecipientTreasury",
    );
  });

  it("allows switching yieldRecipient to an authorized treasury without lane reimbursement config", async function () {
    const { vault } = await deploySystem();
    const replacementTreasury = await viem.deployContract(
      "MockWithdrawalFeeTreasury",
    );
    await replacementTreasury.write.setAuthorizedVault([vault.address, true]);

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

  it("ignores lane reimbursement tuple config when rotating yieldRecipient", async function () {
    const { vault, vaultToken } = await deploySystem();
    const replacementTreasury = await viem.deployContract(
      "MockWithdrawalFeeTreasury",
    );
    await replacementTreasury.write.setAuthorizedVault([vault.address, true]);
    await vault.write.setTrackedTvlTokenOverride([
      vaultToken.address,
      true,
      false,
    ]);

    assert.equal(
      await vault.read.isTrackedTvlToken([vaultToken.address]),
      false,
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

  it("does not require pre-seeding strategy reimbursement tuples before treasury rotation", async function () {
    const { vault, vaultToken, strategy } = await deploySystem();
    const { strategy: aaveStrategy } = await deployAaveV2Lane(
      vault,
      vaultToken,
      "AAVE_V3_USDC_V2_MIXED",
    );
    const replacementTreasury = await viem.deployContract(
      "MockWithdrawalFeeTreasury",
    );
    await replacementTreasury.write.setAuthorizedVault([vault.address, true]);

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
    assert.equal(
      await vault.read.isStrategyWhitelistedForVaultToken([
        vaultToken.address,
        strategy.address,
      ]),
      true,
    );
    assert.equal(await aaveStrategy.read.totalExposure(), 0n);
  });

  it("allows switching yieldRecipient to another compatible treasury contract", async function () {
    const { vault } = await deploySystem();
    const replacementTreasury = await viem.deployContract(
      "MockWithdrawalFeeTreasury",
    );
    await replacementTreasury.write.setAuthorizedVault([vault.address, true]);

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
