import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { expectEventOnce } from "../helpers/events.js";

describe("GRVTDeFiVault harvest and treasury flows", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) throw new Error("wallet has no account");
    return wallet.account.address;
  }

  function writeSetTreasury(
    vaultLike: unknown,
    newTreasury: `0x${string}`,
  ): Promise<`0x${string}`> {
    return (
      vaultLike as {
        write: {
          setTreasury: (args: [`0x${string}`]) => Promise<`0x${string}`>;
        };
      }
    ).write.setTreasury([newTreasury]);
  }

  async function configureTreasuryTimelock(
    vault: {
      address: `0x${string}`;
      write: {
        setTreasuryTimelock: (args: [`0x${string}`]) => Promise<`0x${string}`>;
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
    await vault.write.setTreasuryTimelock([timelock.address]);
    return { timelock, minDelay };
  }

  async function executeSetTreasuryViaTimelock(
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
    newTreasury: `0x${string}`,
    minDelay: bigint,
  ): Promise<`0x${string}`> {
    const data = encodeFunctionData({
      abi: vault.abi as any,
      functionName: "setTreasury",
      args: [newTreasury],
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
    const vaultImpl = await viem.deployContract("GRVTDeFiVault");
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [
        addr(admin),
        bridge.address,
        baseToken.address,
        270n,
        addr(l2Recipient),
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);
    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

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

    await vault.write.setTokenConfig([token.address, { supported: true }]);

    const stratA = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "STRAT_A",
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: true, active: false, cap: 2_000_000n },
    ]);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTDeFiVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
    );
    const vaultAsRebalancer = await viem.getContractAt(
      "GRVTDeFiVault",
      vault.address,
      {
        client: { public: publicClient, wallet: rebalancer },
      },
    );
    const vaultAsPauser = await viem.getContractAt(
      "GRVTDeFiVault",
      vault.address,
      {
        client: { public: publicClient, wallet: pauser },
      },
    );
    const vaultAsAdmin = await viem.getContractAt(
      "GRVTDeFiVault",
      vault.address,
      {
        client: { public: publicClient, wallet: admin },
      },
    );
    const vaultAsOther = await viem.getContractAt(
      "GRVTDeFiVault",
      vault.address,
      {
        client: { public: publicClient, wallet: other },
      },
    );

    return {
      bridge,
      baseToken,
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

    await vaultAsAllocator.write.allocateToStrategy([
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

    const treasury = (await vault.read.treasury()) as `0x${string}`;
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

    await vaultAsAllocator.write.allocateToStrategy([
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

  it("updates treasury via configured timelock, not direct admin", async function () {
    const { vault, vaultAsAdmin, vaultAsOther } = await deployBase();
    const { timelock, minDelay } = await configureTreasuryTimelock(vault);

    await viem.assertions.revertWithCustomError(
      writeSetTreasury(vaultAsOther, addr(other)),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      writeSetTreasury(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "Unauthorized",
    );

    await executeSetTreasuryViaTimelock(vault, timelock, addr(other), minDelay);

    assert.equal(
      ((await vault.read.treasury()) as `0x${string}`).toLowerCase(),
      addr(other).toLowerCase(),
    );
  });

  it("allows principal sync until permanently locked", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([
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

    await vaultAsAdmin.write.lockPrincipalSync();
    assert.equal(await vault.read.principalSyncLocked(), true);

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.syncStrategyPrincipal([token.address, stratA.address]),
      vaultAsAdmin,
      "PrincipalSyncAlreadyLocked",
    );
  });

  it("enforces RBAC on treasury, harvest, and principal-sync admin controls", async function () {
    const { vault, vaultAsAdmin, vaultAsOther, token, stratA } =
      await deployBase();

    await viem.assertions.revertWithCustomError(
      writeSetTreasury(vaultAsOther, addr(other)),
      vaultAsOther,
      "TreasuryTimelockNotSet",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setTreasuryTimelock([addr(other)]),
      vaultAsOther,
      "Unauthorized",
    );

    await configureTreasuryTimelock(vault);
    await viem.assertions.revertWithCustomError(
      writeSetTreasury(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      writeSetTreasury(vaultAsOther, addr(other)),
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
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.lockPrincipalSync(),
      vaultAsOther,
      "Unauthorized",
    );
  });

  it("validates treasury-set and principal-sync-lock edge cases", async function () {
    const { vault, vaultAsAdmin } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setTreasuryTimelock([zeroAddress]),
      vaultAsAdmin,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setTreasuryTimelock([addr(other)]),
      vaultAsAdmin,
      "InvalidParam",
    );

    await viem.assertions.revertWithCustomError(
      writeSetTreasury(vaultAsAdmin, addr(other)),
      vaultAsAdmin,
      "TreasuryTimelockNotSet",
    );

    const { timelock, minDelay } = await configureTreasuryTimelock(vault);
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setTreasuryTimelock([timelock.address]),
      vaultAsAdmin,
      "InvalidParam",
    );
    const currentTreasury = (await vault.read.treasury()) as `0x${string}`;

    await assert.rejects(
      executeSetTreasuryViaTimelock(vault, timelock, zeroAddress, minDelay),
    );
    await assert.rejects(
      executeSetTreasuryViaTimelock(vault, timelock, currentTreasury, minDelay),
    );
    await assert.rejects(
      executeSetTreasuryViaTimelock(vault, timelock, vault.address, minDelay),
    );

    await vaultAsAdmin.write.lockPrincipalSync();
    assert.equal(await vault.read.principalSyncLocked(), true);
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.lockPrincipalSync(),
      vaultAsAdmin,
      "InvalidParam",
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

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratA.address,
      1_200_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      1_200_000n,
    );

    await vaultAsAllocator.write.deallocateFromStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      1_000_000n,
    );

    await vaultAsAllocator.write.deallocateAllFromStrategy([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      0n,
    );

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratA.address,
      1_600_000n,
    ]);
    const principalBefore = (await vault.read.strategyPrincipal([
      token.address,
      stratA.address,
    ])) as bigint;

    await vaultAsRebalancer.write.emergencySendToL2([token.address, 500_000n]);
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
    const { timelock, minDelay } = await configureTreasuryTimelock(vault);

    const allocHash = await vaultAsAllocator.write.allocateToStrategy([
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
      (principalEvent.token as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (principalEvent.strategy as string).toLowerCase(),
      stratA.address.toLowerCase(),
    );
    assert.equal(principalEvent.previousPrincipal, 0n);
    assert.equal(principalEvent.newPrincipal, 200_000n);

    await stratA.write.setAssets([token.address, 230_000n]);
    const treasuryBefore = (await vault.read.treasury()) as `0x${string}`;
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
      (harvestEvent.token as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (harvestEvent.strategy as string).toLowerCase(),
      stratA.address.toLowerCase(),
    );
    assert.equal(
      (harvestEvent.treasury as string).toLowerCase(),
      treasuryBefore.toLowerCase(),
    );
    assert.equal(harvestEvent.requested, 10_000n);
    assert.equal(harvestEvent.received, 10_000n);

    const newTreasury = addr(other);
    const setHash = await executeSetTreasuryViaTimelock(
      vault,
      timelock,
      newTreasury,
      minDelay,
    );
    const setReceipt = await publicClient.waitForTransactionReceipt({
      hash: setHash,
    });
    const updatedEvent = expectEventOnce(setReceipt, vault, "TreasuryUpdated");
    assert.equal(
      (updatedEvent.previousTreasury as string).toLowerCase(),
      treasuryBefore.toLowerCase(),
    );
    assert.equal(
      (updatedEvent.newTreasury as string).toLowerCase(),
      newTreasury.toLowerCase(),
    );

    const lockHash = await vaultAsAdmin.write.lockPrincipalSync();
    const lockReceipt = await publicClient.waitForTransactionReceipt({
      hash: lockHash,
    });
    expectEventOnce(lockReceipt, vault, "PrincipalSyncLockActivated");
  });

  it("uses measured harvest delta when strategy over-reports and emits mismatch telemetry", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token } = await deployBase();
    const overreporting = await viem.deployContract(
      "MockOverreportingStrategy",
      [vault.address],
    );

    await vault.write.whitelistStrategy([
      token.address,
      overreporting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      overreporting.address,
      200_000n,
    ]);
    await overreporting.write.setAssets([token.address, 230_000n]);
    await overreporting.write.setReportExtra([5_000n]);

    const treasury = (await vault.read.treasury()) as `0x${string}`;
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

    await vault.write.setTreasuryTimelock([timelock.address]);

    const newTreasury = addr(other);
    const data = encodeFunctionData({
      abi: vault.abi as any,
      functionName: "setTreasury",
      args: [newTreasury],
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
      ((await vault.read.treasury()) as `0x${string}`).toLowerCase(),
      newTreasury.toLowerCase(),
    );
  });

  it("caps principal decrease at zero when received exceeds tracked principal", async function () {
    const { vault, vaultAsAllocator, vaultAsAdmin, token, stratA } =
      await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([
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
    await vaultAsAllocator.write.deallocateFromStrategy([
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

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratA.address,
      300_000n,
    ]);
    await stratA.write.setAssets([token.address, 340_000n]);

    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);
    const cfg = (await vault.read.getStrategyConfig([
      token.address,
      stratA.address,
    ])) as { whitelisted: boolean; active: boolean; cap: bigint };
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, true);

    const treasury = (await vault.read.treasury()) as `0x${string}`;
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

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratA.address,
      200_000n,
    ]);
    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      200_000n,
    );

    await stratA.write.setAssets([token.address, 0n]);
    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);

    assert.equal(
      await vault.read.strategyPrincipal([token.address, stratA.address]),
      0n,
    );
    const list = (await vault.read.getTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(
      list
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(stratA.address.toLowerCase()),
      false,
    );
  });

  it("keeps auth check precedence for non-admin sync even after sync lock", async function () {
    const { vaultAsAdmin, vaultAsOther, token, stratA } = await deployBase();

    await vaultAsAdmin.write.lockPrincipalSync();
    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.syncStrategyPrincipal([token.address, stratA.address]),
      vaultAsOther,
      "Unauthorized",
    );
  });
});
