import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroHash } from "viem";

import { proxyAdminAbi, readProxyAdminAddress } from "../helpers/proxyAdmin.js";

describe("GRVTDeFiVault upgrade safety", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, l2Recipient, other] = wallets;

  const L2_GAS_LIMIT = 900_000n;
  const L2_GAS_PER_PUBDATA = 800n;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  async function deployVaultProxy() {
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
    return { bridge, vaultImpl, proxy, vault };
  }

  it("rejects initialize() when called a second time", async function () {
    const { bridge, vault } = await deployVaultProxy();

    await viem.assertions.revertWithCustomError(
      vault.write.initialize([addr(admin), bridge.address, addr(l2Recipient)]),
      vault,
      "InvalidInitialization",
    );
  });

  it("enforces admin-only upgrades via ProxyAdmin ownership", async function () {
    const { proxy } = await deployVaultProxy();
    const v2Impl = await viem.deployContract("GRVTDeFiVaultV2Mock");

    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);
    const owner = await publicClient.readContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "owner",
    });
    assert.equal(owner.toLowerCase(), addr(admin).toLowerCase());

    await assert.rejects(
      other.writeContract({
        address: proxyAdmin,
        abi: proxyAdminAbi,
        functionName: "upgradeAndCall",
        args: [proxy.address, v2Impl.address, "0x"],
      }),
    );
  });

  it("upgrades V1 to V2 while preserving state and enabling V2 initializer", async function () {
    const { bridge, proxy, vault } = await deployVaultProxy();

    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    await token.write.mint([vault.address, 2_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [vault.address, "UPGRADE_STRAT"]);

    await vault.write.grantRole([await vault.read.ALLOCATOR_ROLE(), addr(allocator)]);
    await vault.write.grantRole([await vault.read.REBALANCER_ROLE(), addr(rebalancer)]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 100_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 0n,
      },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      { whitelisted: true, cap: 800_000n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });
    const vaultAsRebalancer = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: rebalancer },
    });

    await vaultAsAllocator.write.allocateToStrategy([token.address, strategy.address, 300_000n, "0x"]);
    await vaultAsRebalancer.write.rebalanceToL2([
      token.address,
      100_000n,
      L2_GAS_LIMIT,
      L2_GAS_PER_PUBDATA,
      addr(other),
    ]);
    await vault.write.pause();

    const expectedBridge = await vault.read.bridgeAdapter();
    const expectedRecipient = await vault.read.l2ExchangeRecipient();
    const expectedPaused = await vault.read.paused();
    const expectedLastRebalance = await vault.read.lastRebalanceAt([token.address]);
    const expectedTokenCfg = await vault.read.getTokenConfig([token.address]);
    const expectedStrategyCfg = await vault.read.getStrategyConfig([token.address, strategy.address]);
    const expectedIdle = await vault.read.idleAssets([token.address]);

    const v2Impl = await viem.deployContract("GRVTDeFiVaultV2Mock");
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);

    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, v2Impl.address, "0x"],
    });

    const vaultV2 = await viem.getContractAt("GRVTDeFiVaultV2Mock", proxy.address);

    assert.equal((await vaultV2.read.bridgeAdapter()).toLowerCase(), expectedBridge.toLowerCase());
    assert.equal((await vaultV2.read.l2ExchangeRecipient()).toLowerCase(), expectedRecipient.toLowerCase());
    assert.equal(await vaultV2.read.paused(), expectedPaused);
    assert.equal(await vaultV2.read.lastRebalanceAt([token.address]), expectedLastRebalance);

    const tokenCfgAfter = await vaultV2.read.getTokenConfig([token.address]);
    assert.deepEqual(tokenCfgAfter, expectedTokenCfg);

    const strategyCfgAfter = await vaultV2.read.getStrategyConfig([token.address, strategy.address]);
    assert.deepEqual(strategyCfgAfter, expectedStrategyCfg);

    const strategyList = await vaultV2.read.getTokenStrategies([token.address]);
    assert.ok(strategyList.map((a) => a.toLowerCase()).includes(strategy.address.toLowerCase()));

    assert.equal(await vaultV2.read.idleAssets([token.address]), expectedIdle);
    const [total, skipped] = await vaultV2.read.totalAssetsStatus([token.address]);
    assert.equal(skipped, 0n);
    assert.ok(total >= expectedIdle);

    assert.equal(await vaultV2.read.hasRole([await vaultV2.read.ALLOCATOR_ROLE(), addr(allocator)]), true);
    assert.equal(await vaultV2.read.hasRole([await vaultV2.read.REBALANCER_ROLE(), addr(rebalancer)]), true);

    await vaultV2.write.initializeV2([42n]);
    assert.equal(await vaultV2.read.v2Marker(), 42n);

    await viem.assertions.revertWithCustomError(
      vaultV2.write.initializeV2([7n]),
      vaultV2,
      "InvalidInitialization",
    );
  });
});
