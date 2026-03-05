import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, keccak256, stringToHex } from "viem";

import { expectEventOnce } from "../helpers/events.js";

describe("GRVTL1TreasuryVault harvest and treasury flows", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other] = wallets;

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

  async function configureYieldRecipientTimelock(
    vault: {
      address: `0x${string}`;
      write: {
        setYieldRecipientTimelock: (
          args: [`0x${string}`],
        ) => Promise<`0x${string}`>;
      };
      abi: unknown;
    },
    minDelay: bigint = 2n,
  ) {
    const timelock = await viem.deployContract("TestTimelockController", [
      minDelay,
      [addr(admin)],
      [addr(admin)],
      addr(admin),
    ]);
    await vault.write.setYieldRecipientTimelock([timelock.address]);
    return { timelock, minDelay };
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
    const data = encodeFunctionData({
      abi: vault.abi as any,
      functionName: "setYieldRecipient",
      args: [newYieldRecipient],
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
    if (minDelay > 0n) {
      await increaseTimeAndMine(Number(minDelay));
    }

    return timelock.write.execute([
      vault.address,
      0n,
      data,
      zeroHash,
      zeroHash,
    ]);
  }

  async function increaseTimeAndMine(seconds: number) {
    await (
      publicClient as unknown as {
        request: (args: {
          method: string;
          params?: unknown[];
        }) => Promise<unknown>;
      }
    ).request({
      method: "evm_increaseTime",
      params: [seconds],
    });
    await (
      publicClient as unknown as {
        request: (args: {
          method: string;
          params?: unknown[];
        }) => Promise<unknown>;
      }
    ).request({
      method: "evm_mine",
      params: [],
    });
  }

  async function deployBase() {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const baseToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const vaultImpl = await viem.deployContract("GRVTL1TreasuryVault");
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

    await vault.write.setPrincipalTokenConfig([
      token.address,
      { supported: true },
    ]);

    const stratA = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "STRAT_A",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
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

    return {
      bridge,
      baseToken,
      wrappedNative,
      vault,
      token,
      stratA,
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      vaultAsAdmin,
      vaultAsOther,
    };
  }

  it("tracks principal and harvests strategy yield to treasury", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
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
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      400_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      20_000n,
    );
  });

  it("enforces harvest bounds, slippage guard, and pause gating", async function () {
    const { vaultAsAllocator, vaultAsAdmin, vaultAsPauser, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
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

  it("uses scalar exposure (not reporting components) for harvestable yield and principal sync", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
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

    const breakdown = await vault.read.strategyAssetBreakdown([
      token.address,
      stratA.address,
    ]);
    assert.equal(breakdown.components.length, 1);
    assert.equal(breakdown.components[0].amount, 10_000n);

    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      40_000n,
    );

    await vaultAsAdmin.write.syncStrategyPrincipal([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      240_000n,
    );
  });

  it("uses InvalidStrategyExposureRead for exposure-read failures in harvest/principal paths", async function () {
    const { vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
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
      vaultAsAdmin.write.syncStrategyPrincipal([token.address, stratA.address]),
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

    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const { timelock, minDelay } = await configureYieldRecipientTimelock(
      vault,
      0n,
    );
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      addr(other),
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
      (harvested.principalToken as string).toLowerCase(),
      wrappedNative.address.toLowerCase(),
    );
    assert.equal(
      (harvested.strategy as string).toLowerCase(),
      wethStrategy.address.toLowerCase(),
    );
    assert.equal(harvested.requested, 30_000n);
    assert.equal(harvested.received, 30_000n);
  });

  it("reverts wrapped-native harvest when treasury cannot receive ETH", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const nonPayableTreasury = await viem.deployContract(
      "TestNonPayableTreasury",
    );
    const { timelock, minDelay } = await configureYieldRecipientTimelock(
      vault,
      0n,
    );
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
        30_000n,
        30_000n,
      ]),
      vaultAsAdmin,
      "NativeTransferFailed",
    );
  });

  it("enforces minReceived on wrapped-native harvest using treasury native ETH delta", async function () {
    const { vault, wrappedNative, vaultAsAllocator, vaultAsAdmin } =
      await deployBase();

    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      wrappedNative.address,
      wethStrategy.address,
      400_000n,
    ]);
    await wethStrategy.write.setAssets([wrappedNative.address, 450_000n]);

    const { timelock, minDelay } = await configureYieldRecipientTimelock(
      vault,
      0n,
    );
    await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      addr(other),
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

    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      { supported: true },
    ]);
    const wethStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "WETH_STRAT",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      wrappedNative.address,
      wethStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await wrappedNative.write.deposit({ value: 500_000n });
    await wrappedNative.write.transfer([vault.address, 500_000n]);
    await vaultAsAllocator.write.allocatePrincipalToStrategy([
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

    const { timelock, minDelay } = await configureYieldRecipientTimelock(
      vault,
      0n,
    );
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
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      edgeStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
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

  it("applies principal write-down when harvest deallocation leaves exposure below tracked principal", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();

    const edgeStrategy = await viem.deployContract("MockHarvestEdgeStrategy", [
      vault.address,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      edgeStrategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      edgeStrategy.address,
      400_000n,
    ]);
    await edgeStrategy.write.setExposure([token.address, 420_000n]);
    await edgeStrategy.write.setExposureDropOnDeallocate([
      token.address,
      100_000n,
    ]);

    const hash = await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      edgeStrategy.address,
      20_000n,
      20_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const writeDown = expectEventOnce(
      receipt,
      vault,
      "StrategyPrincipalWrittenDown",
    );
    assert.equal(writeDown.previousPrincipal, 400_000n);
    assert.equal(writeDown.exposureAfter, 300_000n);
    assert.equal(writeDown.newPrincipal, 300_000n);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, edgeStrategy.address]),
      300_000n,
    );
  });

  it("supports sequential harvests without changing tracked principal", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
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
      await vault.read.strategyPrincipal([token.address, stratA.address]),
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
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      300_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      10_000n,
    );
  });

  it("resyncs tracked token state after harvest payout transfer-out", async function () {
    const { vault, vaultAsAdmin, token: baseToken } = await deployBase();

    const token = await viem.deployContract("MockERC20", [
      "HarvestToken",
      "HVT",
      6,
    ]);
    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "HARVEST_ONLY",
    ]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      { supported: true },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    // Seed strategy-held principal token without increasing tracked principal;
    // this models yield-only harvestable balance.
    await token.write.mint([strategy.address, 50_000n]);
    await strategy.write.setAssets([token.address, 50_000n]);

    // Disable token support while exposure still exists; token remains tracked.
    await vault.write.setPrincipalTokenConfig([
      token.address,
      { supported: false },
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      true,
    );

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

    // Post-payout sync should remove unsupported token once both idle and strategy exposure are zero.
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      false,
    );
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(
      await strategy.read.principalBearingExposure([token.address]),
      0n,
    );

    // Sanity check base fixture token stays unaffected.
    assert.equal(
      await vault.read.isTrackedPrincipalToken([baseToken.address]),
      true,
    );
  });

  it("updates treasury via configured timelock, not direct admin", async function () {
    const { vault, vaultAsAdmin, vaultAsOther } = await deployBase();
    const { timelock, minDelay } = await configureYieldRecipientTimelock(vault);

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
      addr(other),
      minDelay,
    );

    assert.equal(
      ((await vault.read.yieldRecipient()) as `0x${string}`).toLowerCase(),
      addr(other).toLowerCase(),
    );
  });

  it("allows repeated principal sync as exposure changes", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    await stratA.write.setAssets([token.address, 150_000n]);

    await vaultAsAdmin.write.syncStrategyPrincipal([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      150_000n,
    );

    await stratA.write.setAssets([token.address, 180_000n]);
    assert.equal(
      await vault.read.harvestableYield([token.address, stratA.address]),
      30_000n,
    );

    await vaultAsAdmin.write.syncStrategyPrincipal([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      180_000n,
    );
  });

  it("enforces RBAC on treasury, harvest, and principal-sync admin controls", async function () {
    const { vault, vaultAsAdmin, vaultAsOther, token, stratA } =
      await deployBase();

    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsOther, addr(other)),
      vaultAsOther,
      "YieldRecipientTimelockNotSet",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setYieldRecipientTimelock([addr(other)]),
      vaultAsOther,
      "Unauthorized",
    );

    await configureYieldRecipientTimelock(vault);
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
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.syncStrategyPrincipal([token.address, stratA.address]),
      vaultAsOther,
      "Unauthorized",
    );
  });

  it("validates treasury-set edge cases", async function () {
    const { vault, vaultAsAdmin } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setYieldRecipientTimelock([zeroAddress]),
      vaultAsAdmin,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setYieldRecipientTimelock([addr(other)]),
      vaultAsAdmin,
      "InvalidParam",
    );

    await viem.assertions.revertWithCustomError(
      writeSetYieldRecipient(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "YieldRecipientTimelockNotSet",
    );

    const { timelock, minDelay } = await configureYieldRecipientTimelock(vault);
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setYieldRecipientTimelock([timelock.address]),
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

  it("validates harvest/sync input constraints and withdrawable-strategy checks", async function () {
    const { vault, vaultAsAdmin, token, stratA } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    const inactive = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "INACTIVE",
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.syncStrategyPrincipal([
        token.address,
        inactive.address,
      ]),
      vaultAsAdmin,
      "StrategyNotWhitelisted",
    );
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
      vaultAsAdmin.write.syncStrategyPrincipal([zeroAddress, stratA.address]),
      vaultAsAdmin,
      "InvalidParam",
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

  it("decreases principal on deallocate, deallocateAll, and emergency unwind", async function () {
    const {
      vault,
      vaultAsAllocator,
      vaultAsRebalancer,
      token,
      stratA,
      bridge,
    } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      1_200_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      1_200_000n,
    );

    await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      1_000_000n,
    );

    await vaultAsAllocator.write.deallocateAllPrincipalFromStrategy([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      0n,
    );

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      1_600_000n,
    ]);
    const principalBefore = (await vault.read.strategyPrincipal([
      token.address,
      stratA.address,
    ])) as bigint;

    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 500_000n]);
    assert.equal(await bridge.read.lastAmount(), 500_000n);

    const principalAfter = (await vault.read.strategyPrincipal([
      token.address,
      stratA.address,
    ])) as bigint;
    assert.equal(principalBefore - principalAfter, 100_000n);
  });

  it("emits new treasury/harvest/principal events with expected args", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();
    const { timelock, minDelay } = await configureYieldRecipientTimelock(vault);

    const allocHash = await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    const allocReceipt = await publicClient.waitForTransactionReceipt({
      hash: allocHash,
    });
    const principalEvent = expectEventOnce(
      allocReceipt,
      vault,
      "StrategyPrincipalUpdated",
    );
    assert.equal(
      (principalEvent.principalToken as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (principalEvent.strategy as string).toLowerCase(),
      stratA.address.toLowerCase(),
    );
    assert.equal(principalEvent.previousPrincipal, 0n);
    assert.equal(principalEvent.newPrincipal, 200_000n);

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
      (harvestEvent.principalToken as string).toLowerCase(),
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

    const newYieldRecipient = addr(other);
    const setHash = await executeSetYieldRecipientViaTimelock(
      vault,
      timelock,
      newYieldRecipient,
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
      newYieldRecipient.toLowerCase(),
    );
  });

  it("uses measured harvest delta when strategy over-reports and emits mismatch telemetry", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();
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
    assert.equal(mismatch.requested, 10_000n);
    assert.equal(mismatch.reported, 15_000n);
    assert.equal(mismatch.actual, 10_000n);

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

    await vault.write.setYieldRecipientTimelock([timelock.address]);

    const newYieldRecipient = addr(other);
    const data = encodeFunctionData({
      abi: vault.abi as any,
      functionName: "setYieldRecipient",
      args: [newYieldRecipient],
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
      newYieldRecipient.toLowerCase(),
    );
  });

  it("caps principal decrease at zero when received exceeds tracked principal", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);

    await stratA.write.setAssets([token.address, 50_000n]);
    await vaultAsAdmin.write.syncStrategyPrincipal([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      50_000n,
    );

    await stratA.write.setAssets([token.address, 300_000n]);
    await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
      token.address,
      stratA.address,
      120_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      0n,
    );
  });

  it("allows harvesting from withdraw-only strategies", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      300_000n,
    ]);
    await stratA.write.setAssets([token.address, 340_000n]);

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);
    const cfg = (await vault.read.getPrincipalStrategyConfig([
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

  it("resets principal to zero when strategy is removed from registry", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      200_000n,
    );

    await stratA.write.setAssets([token.address, 0n]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);

    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      0n,
    );
    const list = (await vault.read.getPrincipalTokenStrategies([
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
