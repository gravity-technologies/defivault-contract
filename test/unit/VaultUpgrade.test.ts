import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { expectEventOnce } from "../helpers/events.js";
import { proxyAdminAbi, readProxyAdminAddress } from "../helpers/proxyAdmin.js";
import {
  deployVaultImplementation,
  deployVaultV2Implementation,
} from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault upgrade safety", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, l2Recipient, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  async function deployVaultProxy() {
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
        addr(other),
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
    return {
      bridge,
      grvtBridgeProxyFeeToken,
      wrappedNative,
      vaultImpl,
      proxy,
      vault,
    };
  }

  async function deployUninitializedVaultProxy() {
    const { vaultImplementation: vaultImpl } =
      await deployVaultImplementation(viem);
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      "0x",
    ]);
    const vault = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      proxy.address,
    );
    return { vault };
  }

  it("rejects initialize() when called a second time", async function () {
    const { bridge, grvtBridgeProxyFeeToken, wrappedNative, vault } =
      await deployVaultProxy();

    await viem.assertions.revertWithCustomError(
      vault.write.initialize([
        addr(admin),
        bridge.address,
        grvtBridgeProxyFeeToken.address,
        270n,
        addr(l2Recipient),
        wrappedNative.address,
        addr(other),
      ]),
      vault,
      "InvalidInitialization",
    );
  });

  it("reverts initialize() when any required parameter is invalid", async function () {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
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
      grvtBridgeProxyFeeToken.address,
      270n,
      addr(l2Recipient),
      wrappedNative.address,
      addr(other),
    ]);
    await expectInvalidInitialize([
      addr(admin),
      zeroAddress,
      grvtBridgeProxyFeeToken.address,
      270n,
      addr(l2Recipient),
      wrappedNative.address,
      addr(other),
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      zeroAddress,
      270n,
      addr(l2Recipient),
      wrappedNative.address,
      addr(other),
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      grvtBridgeProxyFeeToken.address,
      0n,
      addr(l2Recipient),
      wrappedNative.address,
      addr(other),
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      grvtBridgeProxyFeeToken.address,
      270n,
      zeroAddress,
      wrappedNative.address,
      addr(other),
    ]);
    await expectInvalidInitialize([
      addr(admin),
      bridge.address,
      grvtBridgeProxyFeeToken.address,
      270n,
      addr(l2Recipient),
      zeroAddress,
      addr(other),
    ]);
  });

  it("enforces admin-only upgrades via ProxyAdmin ownership", async function () {
    const { proxy, vaultImpl } = await deployVaultProxy();
    const { vaultImplementation: v2Impl } = await deployVaultV2Implementation(
      viem,
      vaultImpl.address,
    );

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
    const { proxy, vault, vaultImpl } = await deployVaultProxy();

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

    await vault.write.setVaultTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 800_000n },
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

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      300_000n,
    ]);
    await vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n]);
    await vault.write.pause();

    const expectedBridgeHub = await vault.read.bridgeHub();
    const expectedBridgeProxyFeeToken =
      await vault.read.grvtBridgeProxyFeeToken();
    const expectedL2ChainId = await vault.read.l2ChainId();
    const expectedRecipient = await vault.read.l2ExchangeRecipient();
    const expectedPaused = await vault.read.paused();
    const expectedTokenCfg = await vault.read.getVaultTokenConfig([
      token.address,
    ]);
    const expectedStrategyCfg = await vault.read.getVaultTokenStrategyConfig([
      token.address,
      strategy.address,
    ]);
    const expectedIdle = await vault.read.idleTokenBalance([token.address]);

    const { vaultImplementation: v2Impl } = await deployVaultV2Implementation(
      viem,
      vaultImpl.address,
    );
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);

    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, v2Impl.address, "0x"],
    });

    assert.equal(
      ((await vault.read.bridgeHub()) as `0x${string}`).toLowerCase(),
      (expectedBridgeHub as `0x${string}`).toLowerCase(),
    );
    assert.equal(
      (
        (await vault.read.grvtBridgeProxyFeeToken()) as `0x${string}`
      ).toLowerCase(),
      (expectedBridgeProxyFeeToken as `0x${string}`).toLowerCase(),
    );
    assert.equal(await vault.read.l2ChainId(), expectedL2ChainId);
    assert.equal(
      ((await vault.read.l2ExchangeRecipient()) as `0x${string}`).toLowerCase(),
      (expectedRecipient as `0x${string}`).toLowerCase(),
    );
    assert.equal(await vault.read.paused(), expectedPaused);

    const tokenCfgAfter = await vault.read.getVaultTokenConfig([token.address]);
    assert.deepEqual(tokenCfgAfter, expectedTokenCfg);

    const strategyCfgAfter = await vault.read.getVaultTokenStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.deepEqual(strategyCfgAfter, expectedStrategyCfg);

    const strategyList = (await vault.read.getVaultTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.ok(
      strategyList
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(strategy.address.toLowerCase()),
    );

    assert.equal(
      await vault.read.idleTokenBalance([token.address]),
      expectedIdle,
    );
    const status = await vault.read.tokenTotalsConservative([token.address]);
    assert.equal(status.skippedStrategies, 0n);
    assert.ok(status.total >= (expectedIdle as bigint));

    assert.equal(
      await vault.read.hasRole([
        await vault.read.ALLOCATOR_ROLE(),
        addr(allocator),
      ]),
      true,
    );
    assert.equal(
      await vault.read.hasRole([
        await vault.read.REBALANCER_ROLE(),
        addr(rebalancer),
      ]),
      true,
    );

    const vaultV2 = await viem.getContractAt(
      "GRVTL1TreasuryVaultV2Mock",
      proxy.address,
    );
    const initReceipt = await publicClient.waitForTransactionReceipt({
      hash: await vaultV2.write.initializeV2([42n]),
    });
    const initEvent = expectEventOnce(initReceipt, vaultV2, "V2Initialized");
    assert.equal(initEvent.marker, 42n);

    await viem.assertions.revertWithCustomError(
      vaultV2.write.initializeV2([7n]),
      vaultV2,
      "InvalidInitialization",
    );
  });
});
