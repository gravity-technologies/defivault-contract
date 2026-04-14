import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { proxyAdminAbi, readProxyAdminAddress } from "../helpers/proxyAdmin.js";
import {
  configureYieldRecipientTimelockController,
  executeSetYieldRecipientViaTimelock,
} from "../helpers/timelock.js";
import {
  deployLegacyVaultImplementation,
  deployVaultImplementation,
} from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault upgrade safety", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, _rebalancer, l2Recipient, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  function normalizeAddresses(addresses: readonly `0x${string}`[]) {
    return addresses.map((addressValue) => addressValue.toLowerCase()).sort();
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

  async function deployLegacyVaultProxy() {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const { vaultImplementation: vaultImpl } =
      await deployLegacyVaultImplementation(viem);
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

  async function deployAaveV2Lane(
    vaultAddress: `0x${string}`,
    vaultTokenAddress: `0x${string}`,
    strategyName = "AAVE_V3_USDT_V2_UPGRADE",
  ) {
    const pool = await viem.deployContract("MockAaveV3Pool", [
      vaultTokenAddress,
    ]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultTokenAddress,
      pool.address,
      "Aave USDT",
      "aUSDT",
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
        vaultAddress,
        pool.address,
        vaultTokenAddress,
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

    return { pool, aToken, implementation, beacon, proxy, strategy };
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
    const { proxy } = await deployLegacyVaultProxy();
    const { vaultImplementation: upgradedImpl } =
      await deployVaultImplementation(viem);

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
        args: [proxy.address, upgradedImpl.address, "0x"],
      }),
    );
  });

  it("upgrades the legacy vault to the current implementation and supports both legacy and V2 strategies", async function () {
    const { proxy, vault } = await deployLegacyVaultProxy();

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 2_000_000n]);

    const legacyStrategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "UPGRADE_STRAT",
    ]);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
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
      legacyStrategy.address,
      { whitelisted: true, active: false, cap: 800_000n },
    ]);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
    );

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      legacyStrategy.address,
      300_000n,
    ]);
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
    const expectedLegacyStrategyCfg =
      await vault.read.getVaultTokenStrategyConfig([
        token.address,
        legacyStrategy.address,
      ]);
    const expectedLegacyCostBasis = await vault.read.strategyCostBasis([
      token.address,
      legacyStrategy.address,
    ]);
    const expectedIdle = await vault.read.idleTokenBalance([token.address]);

    const { vaultImplementation: upgradedImpl } =
      await deployVaultImplementation(viem);
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);

    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, upgradedImpl.address, "0x"],
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

    const legacyStrategyCfgAfter = await vault.read.getVaultTokenStrategyConfig(
      [token.address, legacyStrategy.address],
    );
    assert.deepEqual(legacyStrategyCfgAfter, expectedLegacyStrategyCfg);
    assert.equal(
      await vault.read.strategyCostBasis([
        token.address,
        legacyStrategy.address,
      ]),
      expectedLegacyCostBasis,
    );

    const strategiesBeforeV2 = (await vault.read.getVaultTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.ok(
      strategiesBeforeV2
        .map((addressValue) => addressValue.toLowerCase())
        .includes(legacyStrategy.address.toLowerCase()),
    );

    assert.equal(
      await vault.read.idleTokenBalance([token.address]),
      expectedIdle,
    );
    const status = await vault.read.tokenTotalsConservative([token.address]);
    assert.equal(status.skippedStrategies, 0n);
    assert.equal(status.total, 2_000_000n);

    assert.equal(
      await vault.read.hasRole([
        await vault.read.ALLOCATOR_ROLE(),
        addr(allocator),
      ]),
      true,
    );

    const idleBeforeLegacyExit = await vault.read.idleTokenBalance([
      token.address,
    ]);
    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      legacyStrategy.address,
      50_000n,
    ]);
    assert.equal(
      await vault.read.idleTokenBalance([token.address]),
      (idleBeforeLegacyExit as bigint) + 50_000n,
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        token.address,
        legacyStrategy.address,
      ]),
      expectedLegacyCostBasis - 50_000n,
    );

    await vault.write.unpause();

    const pool = await viem.deployContract("MockAaveV3Pool", [token.address]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      token.address,
      pool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    await pool.write.setAToken([aToken.address]);

    const aaveV2Implementation = await viem.deployContract("AaveV3StrategyV2");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      aaveV2Implementation.address,
      addr(admin),
    ]);
    const initializeData = encodeFunctionData({
      abi: aaveV2Implementation.abi,
      functionName: "initialize",
      args: [
        vault.address,
        pool.address,
        token.address,
        aToken.address,
        "AAVE_V3_USDT_V2_UPGRADE",
      ],
    });
    const v2Proxy = await viem.deployContract("TestBeaconProxy", [
      beacon.address,
      initializeData,
    ]);
    const v2Strategy = await viem.getContractAt(
      "AaveV3StrategyV2",
      v2Proxy.address,
    );

    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      v2Strategy.address,
      { whitelisted: true, active: false, cap: 700_000n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      v2Strategy.address,
      {
        entryCapHundredthBps: 0,
        exitCapHundredthBps: 0,
        policyActive: true,
      },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      v2Strategy.address,
      400_000n,
    ]);

    const v2Policy = await vault.read.getStrategyPolicyConfig([
      token.address,
      v2Strategy.address,
    ]);
    assert.equal(v2Policy.policyActive, true);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, v2Strategy.address]),
      400_000n,
    );
    assert.equal(await v2Strategy.read.totalExposure(), 400_000n);
    assert.equal(await aToken.read.balanceOf([v2Strategy.address]), 400_000n);

    const strategiesAfterUpgrade = (await vault.read.getVaultTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    const normalizedStrategies = strategiesAfterUpgrade.map((addressValue) =>
      addressValue.toLowerCase(),
    );
    assert.ok(
      normalizedStrategies.includes(legacyStrategy.address.toLowerCase()),
    );
    assert.ok(normalizedStrategies.includes(v2Strategy.address.toLowerCase()));
  });

  it("preserves live V2 policy state and treasury rotation across a legacy upgrade", async function () {
    const { proxy, vault } = await deployLegacyVaultProxy();

    const { vaultImplementation: upgradedImpl } =
      await deployVaultImplementation(viem);
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);
    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, upgradedImpl.address, "0x"],
    });

    const vaultAsAdmin = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: admin },
      },
    );
    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
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
    await vault.write.setVaultTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);

    const { timelock, minDelay } =
      await configureYieldRecipientTimelockController(
        viem,
        vault,
        addr(admin),
        2n,
      );
    const treasuryOne = await viem.deployContract("YieldRecipientTreasury", [
      addr(admin),
    ]);
    await treasuryOne.write.setAuthorizedVault([vault.address, true]);
    const treasuryOneBefore = (await token.read.balanceOf([
      treasuryOne.address,
    ])) as bigint;
    await executeSetYieldRecipientViaTimelock(
      publicClient as any,
      vault as any,
      timelock as any,
      treasuryOne.address,
      minDelay,
    );
    assert.equal(
      ((await vault.read.yieldRecipient()) as `0x${string}`).toLowerCase(),
      treasuryOne.address.toLowerCase(),
    );

    const { pool, aToken, strategy } = await deployAaveV2Lane(
      vault.address,
      token.address,
    );
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 700_000n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 0,
        exitCapHundredthBps: 0,
        policyActive: true,
      },
    ]);

    assert.equal(
      await vault.read.hasStrategyPolicyConfig([
        token.address,
        strategy.address,
      ]),
      true,
    );
    const initialPolicy = await vault.read.getStrategyPolicyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(initialPolicy.policyActive, true);
    assert.equal(initialPolicy.entryCapHundredthBps, 0);
    assert.equal(initialPolicy.exitCapHundredthBps, 0);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      400_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      400_000n,
    );
    assert.equal(await aToken.read.balanceOf([strategy.address]), 400_000n);

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      strategy.address,
      50_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      350_000n,
    );
    assert.equal(await aToken.read.balanceOf([strategy.address]), 350_000n);

    await pool.write.accrueYield([strategy.address, 10_000n]);
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      10_000n,
    );
    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      strategy.address,
      10_000n,
      10_000n,
    ]);
    assert.equal(
      (await token.read.balanceOf([treasuryOne.address])) - treasuryOneBefore,
      10_000n,
    );

    const treasuryTwo = await viem.deployContract("YieldRecipientTreasury", [
      addr(admin),
    ]);
    await treasuryTwo.write.setAuthorizedVault([vault.address, true]);
    const treasuryTwoBefore = (await token.read.balanceOf([
      treasuryTwo.address,
    ])) as bigint;
    await executeSetYieldRecipientViaTimelock(
      publicClient as any,
      vault as any,
      timelock as any,
      treasuryTwo.address,
      minDelay,
    );
    assert.equal(
      ((await vault.read.yieldRecipient()) as `0x${string}`).toLowerCase(),
      treasuryTwo.address.toLowerCase(),
    );

    await pool.write.accrueYield([strategy.address, 5_000n]);
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      5_000n,
    );
    await vaultAsAdmin.write.harvestYieldFromStrategy([
      token.address,
      strategy.address,
      5_000n,
      5_000n,
    ]);
    assert.equal(
      (await token.read.balanceOf([treasuryTwo.address])) - treasuryTwoBefore,
      5_000n,
    );

    const postRotationPolicy = await vault.read.getStrategyPolicyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(postRotationPolicy.policyActive, true);
    assert.equal(postRotationPolicy.entryCapHundredthBps, 0);
    assert.equal(postRotationPolicy.exitCapHundredthBps, 0);
  });

  it("finalizes a drained V2 lane and clears its policy metadata", async function () {
    const { vault } = await deployVaultProxy();

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 1_000_000n]);

    const { pool, aToken, strategy } = await deployAaveV2Lane(
      vault.address,
      token.address,
      "AAVE_V3_USDT_V2_FINALIZE",
    );

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
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
      { whitelisted: true, active: false, cap: 700_000n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 0,
        exitCapHundredthBps: 0,
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

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      250_000n,
    ]);
    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      token.address,
      strategy.address,
    ]);
    await token.write.mint([strategy.address, 15_000n], {
      account: other.account,
    });
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      15_000n,
    );
    await token.write.mint([pool.address, 15_000n]);
    await vault.write.harvestYieldFromStrategy([
      token.address,
      strategy.address,
      15_000n,
      15_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      0n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      0n,
    );
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: false, active: true, cap: 700_000n },
    ]);
    await vault.write.finalizeStrategyRemoval([
      token.address,
      strategy.address,
    ]);

    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      0n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      0n,
    );
    assert.equal(
      await vault.read.hasStrategyPolicyConfig([
        token.address,
        strategy.address,
      ]),
      false,
    );

    const strategiesAfterFinalize = (await vault.read.getVaultTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.ok(
      !strategiesAfterFinalize
        .map((addressValue) => addressValue.toLowerCase())
        .includes(strategy.address.toLowerCase()),
    );
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
  });

  it("preserves V2 cost basis and raw harvestable yield across an implementation upgrade", async function () {
    const { proxy, vault } = await deployVaultProxy();

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 1_000_000n]);

    const { pool, aToken, strategy } = await deployAaveV2Lane(
      vault.address,
      token.address,
      "AAVE_V3_USDT_V2_PERSISTENCE",
    );

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
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
      { whitelisted: true, active: false, cap: 700_000n },
    ]);
    await vault.write.setStrategyPolicyConfig([
      token.address,
      strategy.address,
      {
        entryCapHundredthBps: 0,
        exitCapHundredthBps: 0,
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

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      400_000n,
    ]);
    await pool.write.accrueYield([strategy.address, 12_000n]);

    const expectedCostBasis = 400_000n;
    const expectedHarvestable = 12_000n;

    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      expectedCostBasis,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      expectedHarvestable,
    );
    assert.equal(
      await vault.read.hasStrategyPolicyConfig([
        token.address,
        strategy.address,
      ]),
      true,
    );
    assert.equal(await strategy.read.totalExposure(), 412_000n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 412_000n);

    const { vaultImplementation: upgradedImpl } =
      await deployVaultImplementation(viem);
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);

    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, upgradedImpl.address, "0x"],
    });

    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      expectedCostBasis,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      expectedHarvestable,
    );
    assert.equal(
      await vault.read.hasStrategyPolicyConfig([
        token.address,
        strategy.address,
      ]),
      true,
    );

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      token.address,
      strategy.address,
      50_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([token.address, strategy.address]),
      350_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([token.address, strategy.address]),
      expectedHarvestable,
    );
    assert.equal(await strategy.read.totalExposure(), 362_000n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 362_000n);
  });

  it("preserves multi-token legacy state across a legacy-to-current upgrade", async function () {
    const { proxy, vault } = await deployLegacyVaultProxy();

    const tokenA = await viem.deployContract("MockERC20", [
      "Mock USDC",
      "mUSDC",
      6,
    ]);
    const tokenB = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await tokenA.write.mint([vault.address, 1_000_000n]);
    await tokenB.write.mint([vault.address, 1_500_000n]);

    const legacyStrategyA = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "LEGACY_A",
    ]);
    const legacyStrategyB = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "LEGACY_B",
    ]);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.setVaultTokenConfig([
      tokenA.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setVaultTokenConfig([
      tokenB.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setBridgeableVaultToken([tokenA.address, true]);
    await vault.write.setBridgeableVaultToken([tokenB.address, true]);
    await vault.write.setVaultTokenStrategyConfig([
      tokenA.address,
      legacyStrategyA.address,
      { whitelisted: true, active: false, cap: 600_000n },
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      tokenB.address,
      legacyStrategyB.address,
      { whitelisted: true, active: false, cap: 800_000n },
    ]);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
    );

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      tokenA.address,
      legacyStrategyA.address,
      300_000n,
    ]);
    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      tokenB.address,
      legacyStrategyB.address,
      450_000n,
    ]);

    const { vaultImplementation: upgradedImpl } =
      await deployVaultImplementation(viem);
    const proxyAdmin = await readProxyAdminAddress(publicClient, proxy.address);
    await admin.writeContract({
      address: proxyAdmin,
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [proxy.address, upgradedImpl.address, "0x"],
    });

    assert.deepEqual(
      normalizeAddresses(
        (await vault.read.getSupportedVaultTokens()) as readonly `0x${string}`[],
      ),
      normalizeAddresses([tokenA.address, tokenB.address]),
    );
    assert.deepEqual(
      normalizeAddresses(
        (await vault.read.getVaultTokenStrategies([
          tokenA.address,
        ])) as readonly `0x${string}`[],
      ),
      normalizeAddresses([legacyStrategyA.address]),
    );
    assert.deepEqual(
      normalizeAddresses(
        (await vault.read.getVaultTokenStrategies([
          tokenB.address,
        ])) as readonly `0x${string}`[],
      ),
      normalizeAddresses([legacyStrategyB.address]),
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        tokenA.address,
        legacyStrategyA.address,
      ]),
      300_000n,
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        tokenB.address,
        legacyStrategyB.address,
      ]),
      450_000n,
    );

    const totalsA = await vault.read.tokenTotalsConservative([tokenA.address]);
    const totalsB = await vault.read.tokenTotalsConservative([tokenB.address]);
    assert.equal(totalsA.skippedStrategies, 0n);
    assert.equal(totalsB.skippedStrategies, 0n);
    assert.equal(totalsA.total, 1_000_000n);
    assert.equal(totalsB.total, 1_500_000n);

    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      tokenA.address,
      legacyStrategyA.address,
      100_000n,
    ]);
    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      tokenB.address,
      legacyStrategyB.address,
      50_000n,
    ]);

    assert.equal(
      await vault.read.strategyCostBasis([
        tokenA.address,
        legacyStrategyA.address,
      ]),
      200_000n,
    );
    assert.equal(
      await vault.read.strategyCostBasis([
        tokenB.address,
        legacyStrategyB.address,
      ]),
      400_000n,
    );
  });
});
