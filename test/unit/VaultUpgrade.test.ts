import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

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
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const baseToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
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
        wrappedNative.address,
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);

    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);
    return { bridge, baseToken, wrappedNative, vaultImpl, proxy, vault };
  }

  async function deployUninitializedVaultProxy() {
    const vaultImpl = await viem.deployContract("GRVTDeFiVault");
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      "0x",
    ]);
    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);
    return { vault };
  }

  it("rejects initialize() when called a second time", async function () {
    const { bridge, baseToken, wrappedNative, vault } = await deployVaultProxy();

    await viem.assertions.revertWithCustomError(
      vault.write.initialize([
        addr(admin),
        bridge.address,
        baseToken.address,
        270n,
        addr(l2Recipient),
        wrappedNative.address,
      ]),
      vault,
      "InvalidInitialization",
    );
  });

  it("reverts initialize() when any required parameter is invalid", async function () {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const baseToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    const expectInvalidInitialize = async (
      initArgs: readonly [
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        bigint,
        `0x${string}`,
        `0x${string}`,
      ],
    ) => {
      const { vault } = await deployUninitializedVaultProxy();
      await viem.assertions.revertWithCustomError(
        vault.write.initialize(initArgs),
        vault,
        "InvalidParam",
      );
    };

    await expectInvalidInitialize([
      zeroAddress,
      bridge.address,
      baseToken.address,
      270n,
      addr(l2Recipient),
      wrappedNative.address,
    ]);
    await expectInvalidInitialize([
      addr(admin),
      zeroAddress,
      baseToken.address,
      270n,
      addr(l2Recipient),
      wrappedNative.address,
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      zeroAddress,
      270n,
      addr(l2Recipient),
      wrappedNative.address,
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      baseToken.address,
      0n,
      addr(l2Recipient),
      wrappedNative.address,
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      baseToken.address,
      270n,
      zeroAddress,
      wrappedNative.address,
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      baseToken.address,
      270n,
      addr(l2Recipient),
      zeroAddress,
    ]);
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
    const { proxy, vault } = await deployVaultProxy();

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 2_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "UPGRADE_STRAT",
    ]);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.grantRole([
      await vault.read.REBALANCER_ROLE(),
      addr(rebalancer),
    ]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 800_000n },
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

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      strategy.address,
      300_000n,
    ]);
    await vaultAsRebalancer.write.rebalanceToL2([token.address, 100_000n]);
    await vault.write.pause();

    const expectedBridgeHub = await vault.read.bridgeHub();
    const expectedBaseToken = await vault.read.baseToken();
    const expectedL2ChainId = await vault.read.l2ChainId();
    const expectedRecipient = await vault.read.l2ExchangeRecipient();
    const expectedPaused = await vault.read.paused();
    const expectedTokenCfg = await vault.read.getTokenConfig([token.address]);
    const expectedStrategyCfg = await vault.read.getStrategyConfig([
      token.address,
      strategy.address,
    ]);
    const expectedIdle = await vault.read.idleAssets([token.address]);

    const v2Impl = await viem.deployContract("GRVTDeFiVaultV2Mock");
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);

    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, v2Impl.address, "0x"],
    });

    const vaultV2 = await viem.getContractAt(
      "GRVTDeFiVaultV2Mock",
      proxy.address,
    );

    assert.equal(
      ((await vaultV2.read.bridgeHub()) as `0x${string}`).toLowerCase(),
      (expectedBridgeHub as `0x${string}`).toLowerCase(),
    );
    assert.equal(
      ((await vaultV2.read.baseToken()) as `0x${string}`).toLowerCase(),
      (expectedBaseToken as `0x${string}`).toLowerCase(),
    );
    assert.equal(await vaultV2.read.l2ChainId(), expectedL2ChainId);
    assert.equal(
      (
        (await vaultV2.read.l2ExchangeRecipient()) as `0x${string}`
      ).toLowerCase(),
      (expectedRecipient as `0x${string}`).toLowerCase(),
    );
    assert.equal(await vaultV2.read.paused(), expectedPaused);

    const tokenCfgAfter = await vaultV2.read.getTokenConfig([token.address]);
    assert.deepEqual(tokenCfgAfter, expectedTokenCfg);

    const strategyCfgAfter = await vaultV2.read.getStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.deepEqual(strategyCfgAfter, expectedStrategyCfg);

    const strategyList = (await vaultV2.read.getTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.ok(
      strategyList
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(strategy.address.toLowerCase()),
    );

    assert.equal(await vaultV2.read.idleAssets([token.address]), expectedIdle);
    const status = await vaultV2.read.totalAssetsStatus([token.address]);
    assert.equal(status.skippedStrategies, 0n);
    assert.ok(status.total >= (expectedIdle as bigint));

    assert.equal(
      await vaultV2.read.hasRole([
        await vaultV2.read.ALLOCATOR_ROLE(),
        addr(allocator),
      ]),
      true,
    );
    assert.equal(
      await vaultV2.read.hasRole([
        await vaultV2.read.REBALANCER_ROLE(),
        addr(rebalancer),
      ]),
      true,
    );

    await vaultV2.write.initializeV2([42n]);
    assert.equal(await vaultV2.read.v2Marker(), 42n);

    await viem.assertions.revertWithCustomError(
      vaultV2.write.initializeV2([7n]),
      vaultV2,
      "InvalidInitialization",
    );
  });
});
