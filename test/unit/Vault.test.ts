import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroHash } from "viem";

import { expectEventArgs, expectEventCount, expectEventOnce } from "../helpers/events.js";

describe("GRVTDeFiVault", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other] = wallets;

  const L2_GAS_LIMIT = 900_000n;
  const L2_GAS_PER_PUBDATA = 800n;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  async function deployBase() {
    const bridge = await viem.deployContract("MockBridgeAdapter");
    const vaultImpl = await viem.deployContract("GRVTDeFiVault");
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [addr(admin), bridge.address, addr(l2Recipient)],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);
    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    await token.write.mint([vault.address, 2_000_000n]);

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    const pauserRole = await vault.read.PAUSER_ROLE();

    await vault.write.grantRole([allocatorRole, addr(allocator)]);
    await vault.write.grantRole([rebalancerRole, addr(rebalancer)]);
    await vault.write.grantRole([pauserRole, addr(pauser)]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 100_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 60n,
      },
    ]);

    const stratA = await viem.deployContract("MockYieldStrategy", [vault.address, "STRAT_A"]);
    const stratB = await viem.deployContract("MockYieldStrategy", [vault.address, "STRAT_B"]);
    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: true, cap: 800_000n, tag: zeroHash },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      stratB.address,
      { whitelisted: true, cap: 800_000n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });
    const vaultAsRebalancer = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: rebalancer },
    });
    const vaultAsPauser = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: pauser },
    });
    const vaultAsAdmin = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: admin },
    });
    const vaultAsOther = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: other },
    });

    return {
      bridge,
      vault,
      token,
      stratA,
      stratB,
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      vaultAsAdmin,
      vaultAsOther,
    };
  }

  it("enforces RBAC on pause controls", async function () {
    const { vaultAsOther, vaultAsPauser, vault } = await deployBase();

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.pause(),
      vaultAsOther,
      "Unauthorized",
    );

    await vaultAsPauser.write.pause();
    assert.equal(await vault.read.paused(), true);
    await vaultAsPauser.write.unpause();
    assert.equal(await vault.read.paused(), false);
  });

  it("blocks risk-on ops when paused but allows defensive exits", async function () {
    const {
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      token,
      stratA,
      bridge,
    } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 500_000n, "0x"]);
    await vaultAsPauser.write.pause();

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 1n, "0x"]),
      vaultAsAllocator,
      "Paused",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        100_000n,
        L2_GAS_LIMIT,
        L2_GAS_PER_PUBDATA,
        addr(other),
      ]),
      vaultAsRebalancer,
      "Paused",
    );

    await vaultAsAllocator.write.deallocateFromStrategy([token.address, stratA.address, 100_000n, "0x"]);
    await vaultAsRebalancer.write.emergencySendToL2([
      token.address,
      200_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);

    assert.equal(await bridge.read.lastAmount(), 200_000n);
  });

  it("uses supported flag for risk-on ops only", async function () {
    const {
      vault,
      vaultAsAllocator,
      vaultAsRebalancer,
      token,
      stratA,
      bridge,
      vaultAsAdmin,
    } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 600_000n, "0x"]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: false,
        idleReserve: 100_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 60n,
      },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 1n, "0x"]),
      vaultAsAllocator,
      "TokenNotSupported",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        100_000n,
        L2_GAS_LIMIT,
        L2_GAS_PER_PUBDATA,
        addr(other),
      ]),
      vaultAsRebalancer,
      "TokenNotSupported",
    );

    await vaultAsAdmin.write.deallocateFromStrategy([token.address, stratA.address, 150_000n, "0x"]);
    await vaultAsAdmin.write.deallocateAllFromStrategy([token.address, stratA.address, "0x"]);

    await vaultAsRebalancer.write.emergencySendToL2([
      token.address,
      100_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);

    assert.equal(await bridge.read.lastAmount(), 100_000n);
  });

  it("allows VAULT_ADMIN fallback for partial and full deallocation", async function () {
    const { vaultAsAllocator, vaultAsAdmin, vaultAsOther, vault, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 400_000n, "0x"]);

    await vaultAsAdmin.write.deallocateFromStrategy([token.address, stratA.address, 150_000n, "0x"]);
    assert.equal(await vault.read.strategyAssets([token.address, stratA.address]), 250_000n);

    await vaultAsAdmin.write.deallocateAllFromStrategy([token.address, stratA.address, "0x"]);
    assert.equal(await vault.read.strategyAssets([token.address, stratA.address]), 0n);

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.deallocateFromStrategy([token.address, stratA.address, 1n, "0x"]),
      vaultAsOther,
      "Unauthorized",
    );
  });

  it("keeps de-whitelisted strategy in withdraw-only mode until assets reach zero", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 300_000n, "0x"]);

    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: false, cap: 0n, tag: zeroHash },
    ]);

    const cfgAfterDisable = await vault.read.getStrategyConfig([token.address, stratA.address]);
    assert.equal(cfgAfterDisable.whitelisted, false);

    const listedAfterDisable = await vault.read.getTokenStrategies([token.address]);
    assert.ok(listedAfterDisable.map((a) => a.toLowerCase()).includes(stratA.address.toLowerCase()));

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 1n, "0x"]),
      vaultAsAllocator,
      "StrategyNotWhitelisted",
    );

    await vaultAsAllocator.write.deallocateAllFromStrategy([token.address, stratA.address, "0x"]);
    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: false, cap: 0n, tag: zeroHash },
    ]);

    const listedAfterRemoval = await vault.read.getTokenStrategies([token.address]);
    assert.equal(
      listedAfterRemoval.map((a) => a.toLowerCase()).includes(stratA.address.toLowerCase()),
      false,
    );

    const cfgAfterRemoval = await vault.read.getStrategyConfig([token.address, stratA.address]);
    assert.equal(cfgAfterRemoval.whitelisted, false);
    assert.equal(cfgAfterRemoval.cap, 0n);
    assert.equal(cfgAfterRemoval.tag, zeroHash);
  });

  it("keeps totalAssets callable when one strategy reverts and reports skipped count", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();
    const reverting = await viem.deployContract("MockRevertingStrategy");

    await vault.write.whitelistStrategy([
      token.address,
      reverting.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 400_000n, "0x"]);

    const [totalStatus, skipped] = await vault.read.totalAssetsStatus([token.address]);
    assert.equal(skipped, 1n);

    const idle = await vault.read.idleAssets([token.address]);
    const stratATvl = await vault.read.strategyAssets([token.address, stratA.address]);
    const total = await vault.read.totalAssets([token.address]);

    assert.equal(totalStatus, idle + stratATvl);
    assert.equal(total, totalStatus);
  });

  it("sweepNative is admin-only and checks amount bounds", async function () {
    const { vault, vaultAsAdmin, vaultAsOther } = await deployBase();

    const initialVaultBalance = await publicClient.getBalance({ address: vault.address });
    await admin.sendTransaction({
      to: vault.address,
      value: 1_000_000_000_000_000n,
    });
    const fundedVaultBalance = await publicClient.getBalance({ address: vault.address });
    assert.equal(fundedVaultBalance, initialVaultBalance + 1_000_000_000_000_000n);

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.sweepNative([addr(other), 1n]),
      vaultAsOther,
      "Unauthorized",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.sweepNative([addr(other), fundedVaultBalance + 1n]),
      vaultAsAdmin,
      "InvalidParam",
    );

    const recipientBefore = await publicClient.getBalance({ address: addr(l2Recipient) });
    await vaultAsAdmin.write.sweepNative([addr(l2Recipient), 400_000_000_000_000n]);

    const recipientAfter = await publicClient.getBalance({ address: addr(l2Recipient) });
    const vaultAfter = await publicClient.getBalance({ address: vault.address });

    assert.equal(recipientAfter - recipientBefore, 400_000_000_000_000n);
    assert.equal(vaultAfter, fundedVaultBalance - 400_000_000_000_000n);
  });

  it("updates bridge adapter with immediate effect and emits event", async function () {
    const { vault, vaultAsAdmin, vaultAsOther, vaultAsRebalancer, token, bridge } = await deployBase();
    const newBridge = await viem.deployContract("MockBridgeAdapter");

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setBridgeAdapter([newBridge.address]),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setBridgeAdapter(["0x0000000000000000000000000000000000000000"]),
      vaultAsAdmin,
      "InvalidParam",
    );

    const txHash = await vaultAsAdmin.write.setBridgeAdapter([newBridge.address]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const eventArgs = expectEventOnce(receipt, vault, "BridgeAdapterUpdated");
    expectEventArgs(eventArgs, {
      previousAdapter: bridge.address,
      newAdapter: newBridge.address,
    });

    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      120_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);

    assert.equal(await bridge.read.sendCount(), 0n);
    assert.equal(await newBridge.read.sendCount(), 1n);
    assert.equal((await newBridge.read.lastL2Receiver()).toLowerCase(), addr(l2Recipient).toLowerCase());
  });

  it("updates L2 recipient with immediate effect and emits event", async function () {
    const { vault, vaultAsAdmin, vaultAsOther, vaultAsRebalancer, token, bridge } = await deployBase();
    const newRecipient = addr(other);

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setL2ExchangeRecipient([newRecipient]),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.setL2ExchangeRecipient(["0x0000000000000000000000000000000000000000"]),
      vaultAsAdmin,
      "InvalidParam",
    );

    const txHash = await vaultAsAdmin.write.setL2ExchangeRecipient([newRecipient]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const eventArgs = expectEventOnce(receipt, vault, "L2ExchangeRecipientUpdated");
    expectEventArgs(eventArgs, {
      previousRecipient: addr(l2Recipient),
      newRecipient,
    });

    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      110_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);
    assert.equal((await bridge.read.lastL2Receiver()).toLowerCase(), newRecipient.toLowerCase());
  });

  it("applies token config changes immediately while funds are live", async function () {
    const { vault, vaultAsAllocator, vaultAsRebalancer, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 600_000n, "0x"]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 1_350_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 60n,
      },
    ]);

    assert.equal(await vault.read.availableForRebalance([token.address]), 50_000n);
    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        60_000n,
        L2_GAS_LIMIT,
        L2_GAS_PER_PUBDATA,
        addr(other),
      ]),
      vaultAsRebalancer,
      "InvalidParam",
    );

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 100_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 60n,
      },
    ]);

    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      60_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);
  });

  it("enforces sequential cap boundaries and reserve interaction", async function () {
    const { vault, vaultAsAllocator, token, stratA, stratB } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 300_000n, "0x"]);
    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 500_000n, "0x"]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 1n, "0x"]),
      vaultAsAllocator,
      "CapExceeded",
    );

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 1_150_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 60n,
      },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([token.address, stratB.address, 60_000n, "0x"]),
      vaultAsAllocator,
      "InvalidParam",
    );

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratB.address, 50_000n, "0x"]);
  });

  it("enforces cap updates against live strategy positions", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 400_000n, "0x"]);

    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: true, cap: 350_000n, tag: zeroHash },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 1n, "0x"]),
      vaultAsAllocator,
      "CapExceeded",
    );

    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: true, cap: 500_000n, tag: zeroHash },
    ]);

    await vaultAsAllocator.write.allocateToStrategy([token.address, stratA.address, 50_000n, "0x"]);
    assert.equal(await vault.read.strategyAssets([token.address, stratA.address]), 450_000n);
  });

  it("allows back-to-back rebalance when minDelay is zero", async function () {
    const { vault, vaultAsRebalancer, token, bridge } = await deployBase();

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 100_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 0n,
      },
    ]);

    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      100_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);
    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      100_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);

    assert.equal(await bridge.read.sendCount(), 2n);
  });

  it("treats rebalanceMaxPerTx=0 as unlimited", async function () {
    const { vault, vaultAsRebalancer, token, bridge } = await deployBase();

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 0n,
        rebalanceMaxPerTx: 0n,
        rebalanceMinDelay: 0n,
      },
    ]);

    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      1_200_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);

    assert.equal(await bridge.read.lastAmount(), 1_200_000n);
  });

  it("returns zero available when idleReserve equals idle and rejects rebalance", async function () {
    const { vault, vaultAsRebalancer, token } = await deployBase();

    const idle = await vault.read.idleAssets([token.address]);
    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: idle,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 0n,
      },
    ]);

    assert.equal(await vault.read.availableForRebalance([token.address]), 0n);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        1n,
        L2_GAS_LIMIT,
        L2_GAS_PER_PUBDATA,
        addr(other),
      ]),
      vaultAsRebalancer,
      "InvalidParam",
    );
  });

  it("emits timestamp update only on normal rebalance and enforces min-delay and max", async function () {
    const { vaultAsRebalancer, vault, token } = await deployBase();

    const firstHash = await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      300_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);
    const firstReceipt = await publicClient.waitForTransactionReceipt({ hash: firstHash });
    expectEventCount(firstReceipt, vault, "RebalanceTimestampUpdated", 1);

    const firstTs = await vault.read.lastRebalanceAt([token.address]);
    assert.notEqual(firstTs, 0n);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        100_000n,
        L2_GAS_LIMIT,
        L2_GAS_PER_PUBDATA,
        addr(other),
      ]),
      vaultAsRebalancer,
      "RateLimited",
    );

    await testClient.increaseTime({ seconds: 61 });
    await testClient.mine({ blocks: 1 });

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        700_000n,
        L2_GAS_LIMIT,
        L2_GAS_PER_PUBDATA,
        addr(other),
      ]),
      vaultAsRebalancer,
      "CapExceeded",
    );

    const emergencyHash = await vaultAsRebalancer.write.emergencySendToL2([
      token.address,
      100_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);
    const emergencyReceipt = await publicClient.waitForTransactionReceipt({ hash: emergencyHash });

    expectEventCount(emergencyReceipt, vault, "RebalanceTimestampUpdated", 0);
    const tsAfterEmergency = await vault.read.lastRebalanceAt([token.address]);
    assert.equal(tsAfterEmergency, firstTs);
  });

  it("reflects strategy yield accrual in vault totalAssets", async function () {
    const bridge = await viem.deployContract("MockBridgeAdapter");
    const vaultImpl = await viem.deployContract("GRVTDeFiVault");
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [addr(admin), bridge.address, addr(l2Recipient)],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);
    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    await token.write.mint([vault.address, 1_000_000n]);

    await vault.write.grantRole([await vault.read.ALLOCATOR_ROLE(), addr(allocator)]);
    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 0n,
        rebalanceMaxPerTx: 0n,
        rebalanceMinDelay: 0n,
      },
    ]);

    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3Pool", [token.address, aToken.address]);
    await aToken.write.setUnderlyingAsset([token.address]);
    await aToken.write.setPool([pool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const strategyInitData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [vault.address, pool.address, token.address, aToken.address, "AAVE_GROWTH"],
    });
    const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      strategyImpl.address,
      addr(admin),
      strategyInitData,
    ]);
    const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy.address);

    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });

    await vaultAsAllocator.write.allocateToStrategy([token.address, strategy.address, 400_000n, "0x"]);
    const before = await vault.read.totalAssets([token.address]);

    await pool.write.accrueYield([strategy.address, 25_000n]);

    const after = await vault.read.totalAssets([token.address]);
    const [statusTotal, skipped] = await vault.read.totalAssetsStatus([token.address]);

    assert.equal(after - before, 25_000n);
    assert.equal(skipped, 0n);
    assert.equal(statusTotal, after);
  });
});
