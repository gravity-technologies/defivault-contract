import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault rebalance liveness", async function () {
  const { viem } = await network.connect();
  const [admin, yieldRecipient, other] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const supportedTokenConfig = { supported: true };
  const unsupportedTokenConfig = { supported: false };

  async function deploySystem({
    setNativeBridgeGateway = true,
  }: { setNativeBridgeGateway?: boolean } = {}) {
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
      "Base Token",
      "BASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
    ]);
    const bridgeHub = await viem.deployContract("MockBridgehub", [
      grvtBridgeProxyFeeToken.address,
    ]);

    const { vaultImplementation: implementation } =
      await deployVaultImplementation(viem);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        admin.account.address,
        bridgeHub.address,
        grvtBridgeProxyFeeToken.address,
        270n,
        admin.account.address,
        wrappedNative.address,
        yieldRecipient.account.address,
      ],
    });

    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);

    const vault = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      proxy.address,
    );

    const nativeBridgeGatewayImplementation = await viem.deployContract(
      "NativeBridgeGateway",
      [],
    );
    const nativeBridgeGatewayInitializeData = encodeFunctionData({
      abi: nativeBridgeGatewayImplementation.abi,
      functionName: "initialize",
      args: [
        wrappedNative.address,
        grvtBridgeProxyFeeToken.address,
        bridgeHub.address,
        vault.address,
      ],
    });
    const nativeBridgeGatewayProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [
        nativeBridgeGatewayImplementation.address,
        admin.account.address,
        nativeBridgeGatewayInitializeData,
      ],
    );
    const nativeBridgeGateway = await viem.getContractAt(
      "NativeBridgeGateway",
      nativeBridgeGatewayProxy.address,
    );

    if (setNativeBridgeGateway) {
      await vault.write.setNativeBridgeGateway([nativeBridgeGateway.address]);
    }

    return {
      vault,
      token,
      grvtBridgeProxyFeeToken,
      bridgeHub,
      wrappedNative,
      nativeBridgeGateway,
    };
  }

  async function deployAaveStrategy(
    vaultAddress: `0x${string}`,
    underlyingAddress: `0x${string}`,
  ) {
    const pool = await viem.deployContract("MockAaveV3Pool", [
      underlyingAddress,
    ]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      underlyingAddress,
      pool.address,
      "Aave Mock Token",
      "aMOCK",
    ]);
    await pool.write.setAToken([aToken.address]);

    const implementation = await viem.deployContract("AaveV3Strategy");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vaultAddress,
        pool.address,
        underlyingAddress,
        aToken.address,
        "AAVE_V3_MOCK",
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);
    const strategy = await viem.getContractAt("AaveV3Strategy", proxy.address);

    return { strategy, aToken };
  }

  it("allows multiple rebalanceErc20ToL2 calls without time/size rate limiting", async function () {
    const { vault, token, grvtBridgeProxyFeeToken, bridgeHub } =
      await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await token.write.mint([vault.address, 200n]);

    await vault.write.rebalanceErc20ToL2([token.address, 80n]);
    await vault.write.rebalanceErc20ToL2([token.address, 40n]);

    assert.equal(await bridgeHub.read.requestCount(), 2n);
    assert.equal(await token.read.balanceOf([vault.address]), 80n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 120n);
    assert.equal(
      await grvtBridgeProxyFeeToken.read.balanceOf([bridgeHub.address]),
      2n,
    );
  });

  it("allows emergencyErc20ToL2 while paused and token support is disabled", async function () {
    const { vault, token, grvtBridgeProxyFeeToken, bridgeHub } =
      await deploySystem();

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await vault.write.setVaultTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);

    await token.write.mint([vault.address, 75n]);
    await vault.write.pause();

    await vault.write.emergencyErc20ToL2([token.address, 75n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 75n);
    assert.equal(
      await grvtBridgeProxyFeeToken.read.balanceOf([bridgeHub.address]),
      1n,
    );
    assert.equal(await vault.read.paused(), true);
  });

  it("fully exits Aave exposure during emergency unwind when residual underlying is included in exposure", async function () {
    const { vault, token, bridgeHub } = await deploySystem();
    const { strategy, aToken } = await deployAaveStrategy(
      vault.address,
      token.address,
    );

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await token.write.mint([vault.address, 100n]);
    await vault.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100n,
    ]);
    await token.write.mint([strategy.address, 1n]);

    assert.equal(await strategy.read.strategyExposure([token.address]), 101n);

    await vault.write.setVaultTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);
    await vault.write.pause();
    await vault.write.emergencyErc20ToL2([token.address, 101n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 101n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await token.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure([token.address]), 0n);
  });

  it("uses bounded Aave deallocation for partial emergency unwinds", async function () {
    const { vault, token, bridgeHub } = await deploySystem();
    const { strategy, aToken } = await deployAaveStrategy(
      vault.address,
      token.address,
    );

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await token.write.mint([vault.address, 100n]);
    await vault.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100n,
    ]);
    await token.write.mint([strategy.address, 1n]);

    await vault.write.setVaultTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);
    await vault.write.pause();
    await vault.write.emergencyErc20ToL2([token.address, 50n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastAmount(), 50n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 50n);
    assert.equal(await token.read.balanceOf([vault.address]), 1n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 50n);
    assert.equal(await token.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure([token.address]), 50n);
  });

  it("uses Aave full-exit deallocation when the emergency unwind drains the whole strategy", async function () {
    const { vault, token, bridgeHub } = await deploySystem();
    const { strategy, aToken } = await deployAaveStrategy(
      vault.address,
      token.address,
    );

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await token.write.mint([vault.address, 100n]);
    await vault.write.allocateVaultTokenToStrategy([
      token.address,
      strategy.address,
      100n,
    ]);

    await vault.write.setVaultTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);
    await vault.write.pause();
    await vault.write.emergencyErc20ToL2([token.address, 100n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastAmount(), 100n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 100n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await token.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure([token.address]), 0n);
  });

  it("reverts rebalanceErc20ToL2 while paused", async function () {
    const { vault, token } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setBridgeableVaultToken([token.address, true]);
    await token.write.mint([vault.address, 50n]);
    await vault.write.pause();

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceErc20ToL2([token.address, 10n]),
      vault,
      "Paused",
    );
  });

  it("reverts rebalanceErc20ToL2 for supported but non-bridgeable tokens", async function () {
    const { vault, token } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await token.write.mint([vault.address, 50n]);

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceErc20ToL2([token.address, 10n]),
      vault,
      "TokenNotBridgeable",
    );
  });

  it("reverts emergencyErc20ToL2 for non-bridgeable tokens even when paused", async function () {
    const { vault, token } = await deploySystem();

    await vault.write.setVaultTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await token.write.mint([vault.address, 50n]);
    await vault.write.pause();

    await viem.assertions.revertWithCustomError(
      vault.write.emergencyErc20ToL2([token.address, 10n]),
      vault,
      "TokenNotBridgeable",
    );
  });

  it("routes native rebalance through native bridge branch", async function () {
    const {
      vault,
      grvtBridgeProxyFeeToken,
      bridgeHub,
      wrappedNative,
      nativeBridgeGateway,
    } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 20n });
    await wrappedNative.write.transfer([vault.address, 20n]);

    await vault.write.rebalanceNativeToL2([12n]);

    const nativeTokenAddress = await bridgeHub.read.nativeTokenAddress();
    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastToken(), nativeTokenAddress);
    assert.equal(await bridgeHub.read.lastAmount(), 12n);
    assert.equal(await bridgeHub.read.lastSecondBridgeValue(), 12n);
    assert.equal(await bridgeHub.read.lastMsgValue(), 12n);
    assert.equal(
      (await bridgeHub.read.lastDepositSender()).toLowerCase(),
      nativeBridgeGateway.address.toLowerCase(),
    );
    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 8n);
    assert.equal(
      await wrappedNative.read.balanceOf([nativeBridgeGateway.address]),
      0n,
    );
    assert.equal(
      await grvtBridgeProxyFeeToken.read.balanceOf([bridgeHub.address]),
      1n,
    );
    assert.equal(
      await publicClient.getBalance({ address: bridgeHub.address }),
      12n,
    );
    assert.equal(
      await publicClient.getBalance({ address: nativeBridgeGateway.address }),
      0n,
    );
  });

  it("rejects explicit wrapped native token bridge-out", async function () {
    const { vault, wrappedNative } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceErc20ToL2([wrappedNative.address, 1n]),
      vault,
      "InvalidParam",
    );
  });

  it("routes native emergency sends through native bridge branch", async function () {
    const { vault, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      unsupportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 9n });
    await wrappedNative.write.transfer([vault.address, 9n]);
    await vault.write.pause();

    await vault.write.emergencyNativeToL2([9n]);

    const nativeTokenAddress = await bridgeHub.read.nativeTokenAddress();
    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastToken(), nativeTokenAddress);
    assert.equal(await bridgeHub.read.lastSecondBridgeValue(), 9n);
    assert.equal(await bridgeHub.read.lastMsgValue(), 9n);
    assert.equal(
      (await bridgeHub.read.lastDepositSender()).toLowerCase(),
      nativeBridgeGateway.address.toLowerCase(),
    );
  });

  it("reverts native rebalance when native bridge gateway is unset", async function () {
    const { vault, wrappedNative } = await deploySystem({
      setNativeBridgeGateway: false,
    });

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);
    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 5n });
    await wrappedNative.write.transfer([vault.address, 5n]);

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceNativeToL2([5n]),
      vault,
      "NativeBridgeGatewayNotSet",
    );
  });

  it("rejects direct ETH ingress from non-wrapper senders", async function () {
    const { vault } = await deploySystem();

    await assert.rejects(
      admin.sendTransaction({
        account: admin.account,
        to: vault.address,
        value: 1n,
      }),
      /revert|reverted|execution reverted/i,
    );
  });

  it("supports external native ingress via NativeVaultGateway", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);

    await admin.sendTransaction({
      account: admin.account,
      to: gateway.address,
      value: 6n,
    });

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 6n);
    assert.equal(await wrappedNative.read.balanceOf([gateway.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: gateway.address }),
      0n,
    );
  });

  it("supports explicit depositToVault() calls on NativeVaultGateway", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);

    await gateway.write.depositToVault({ value: 4n });

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 4n);
    assert.equal(await wrappedNative.read.balanceOf([gateway.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: gateway.address }),
      0n,
    );
  });

  it("rejects stipend-based transfer sends into NativeVaultGateway.receive()", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);
    const sender = await viem.deployContract("TestNativeSender", []);

    await admin.sendTransaction({
      account: admin.account,
      to: sender.address,
      value: 3n,
    });

    await assert.rejects(
      sender.write.sendViaTransfer([gateway.address, 1n]),
      /revert|reverted|execution reverted/i,
    );

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: gateway.address }),
      0n,
    );
    assert.equal(
      await publicClient.getBalance({ address: sender.address }),
      3n,
    );
  });

  it("returns false for stipend-based send() into NativeVaultGateway.receive()", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);
    const sender = await viem.deployContract("TestNativeSender", []);

    await admin.sendTransaction({
      account: admin.account,
      to: sender.address,
      value: 3n,
    });

    await sender.write.sendViaSend([gateway.address, 1n]);

    assert.equal(await sender.read.lastSendResult(), false);
    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: gateway.address }),
      0n,
    );
    assert.equal(
      await publicClient.getBalance({ address: sender.address }),
      3n,
    );
  });

  it("lets vault admins recover unexpected native ETH held by NativeVaultGateway", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);

    await (
      publicClient as unknown as {
        request: (args: {
          method: string;
          params?: unknown[];
        }) => Promise<unknown>;
      }
    ).request({
      method: "hardhat_setBalance",
      params: [gateway.address, "0x7"],
    });

    const recipientBefore = await publicClient.getBalance({
      address: yieldRecipient.account.address,
    });
    await gateway.write.sweepNative([yieldRecipient.account.address, 7n]);

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: gateway.address }),
      0n,
    );
    assert.equal(
      await publicClient.getBalance({
        address: yieldRecipient.account.address,
      }),
      recipientBefore + 7n,
    );
  });

  it("lets vault admins recover unexpected ERC20 balances held by NativeVaultGateway", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);
    const strayToken = await viem.deployContract("MockERC20", [
      "Stray Token",
      "STRAY",
      18,
    ]);

    await strayToken.write.mint([gateway.address, 9n]);
    await gateway.write.sweepToken([
      strayToken.address,
      yieldRecipient.account.address,
      9n,
    ]);

    assert.equal(
      await strayToken.read.balanceOf([yieldRecipient.account.address]),
      9n,
    );
    assert.equal(await strayToken.read.balanceOf([gateway.address]), 0n);
  });

  it("rejects zero-value native vault gateway calls", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);

    await viem.assertions.revertWithCustomError(
      gateway.write.depositToVault({ value: 0n }),
      gateway,
      "InvalidParam",
    );
  });

  it("restricts NativeVaultGateway rescue sweeps to vault admins and valid balances", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);
    const strayToken = await viem.deployContract("MockERC20", [
      "Stray Token",
      "STRAY",
      18,
    ]);
    const gatewayAsOther = await viem.getContractAt(
      "NativeVaultGateway",
      gateway.address,
      {
        client: { public: publicClient, wallet: other },
      },
    );

    await viem.assertions.revertWithCustomError(
      gatewayAsOther.write.sweepNative([other.account.address, 1n]),
      gatewayAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      gatewayAsOther.write.sweepToken([
        strayToken.address,
        other.account.address,
        1n,
      ]),
      gatewayAsOther,
      "Unauthorized",
    );

    await viem.assertions.revertWithCustomError(
      gateway.write.sweepNative([yieldRecipient.account.address, 1n]),
      gateway,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      gateway.write.sweepToken([
        strayToken.address,
        yieldRecipient.account.address,
        1n,
      ]),
      gateway,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      gateway.write.sweepToken([
        zeroAddress,
        yieldRecipient.account.address,
        1n,
      ]),
      gateway,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      gateway.write.sweepNative([zeroAddress, 1n]),
      gateway,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      gateway.write.sweepToken([strayToken.address, zeroAddress, 1n]),
      gateway,
      "InvalidParam",
    );
  });

  it("rejects calldata-bearing native sends to native vault gateway", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const gateway = await viem.deployContract("NativeVaultGateway", [
      wrappedNative.address,
      vault.address,
    ]);

    await viem.assertions.revertWithCustomError(
      admin.sendTransaction({
        account: admin.account,
        to: gateway.address,
        value: 1n,
        data: "0x1234",
      }),
      gateway,
      "InvalidParam",
    );
  });

  it("atomically claims and recovers a failed native deposit back to the vault", async function () {
    const { vault, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);
    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 12n });
    await wrappedNative.write.transfer([vault.address, 12n]);

    await vault.write.rebalanceNativeToL2([12n]);

    const bridgeTxHash = await bridgeHub.read.lastTxHash();
    const nativeTokenVault = await bridgeHub.read.nativeTokenVault();
    assert.notEqual(
      nativeTokenVault.toLowerCase(),
      bridgeHub.address.toLowerCase(),
    );
    await nativeBridgeGateway.write.claimAndRecoverFailedNativeDeposit([
      bridgeTxHash,
      0n,
      0n,
      0,
      [],
    ]);

    const bridgeRecord = await nativeBridgeGateway.read.nativeBridgeRecords([
      bridgeTxHash,
    ]);

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 12n);
    assert.equal(
      await wrappedNative.read.balanceOf([nativeBridgeGateway.address]),
      0n,
    );
    assert.equal(
      await publicClient.getBalance({ address: nativeBridgeGateway.address }),
      0n,
    );
    assert.equal(
      await publicClient.getBalance({ address: bridgeHub.address }),
      0n,
    );
    assert.equal(bridgeRecord[2], true);
  });

  it("rejects recovering a different record against claimed native ETH", async function () {
    const { vault, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);
    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 22n });
    await wrappedNative.write.transfer([vault.address, 22n]);

    await vault.write.rebalanceNativeToL2([12n]);
    const largerBridgeTxHash = await bridgeHub.read.lastTxHash();
    await vault.write.rebalanceNativeToL2([10n]);
    const smallerBridgeTxHash = await bridgeHub.read.lastTxHash();
    const nativeTokenAddress = await bridgeHub.read.nativeTokenAddress();

    await bridgeHub.write.claimFailedDeposit([
      270n,
      nativeBridgeGateway.address,
      nativeTokenAddress,
      12n,
      largerBridgeTxHash,
      0n,
      0n,
      0,
      [],
    ]);

    await viem.assertions.revertWithCustomError(
      nativeBridgeGateway.write.recoverClaimedNativeDeposit([
        smallerBridgeTxHash,
      ]),
      nativeBridgeGateway,
      "InvalidGatewayNativeBalance",
    );

    await nativeBridgeGateway.write.recoverClaimedNativeDeposit([
      largerBridgeTxHash,
    ]);

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 12n);
    assert.equal(
      await publicClient.getBalance({ address: nativeBridgeGateway.address }),
      0n,
    );
  });

  it("restricts native bridge recovery operations to vault admins", async function () {
    const { bridgeHub, nativeBridgeGateway } = await deploySystem();
    const gatewayAsOther = await viem.getContractAt(
      "NativeBridgeGateway",
      nativeBridgeGateway.address,
      {
        client: { public: publicClient, wallet: other },
      },
    );
    const strayToken = await viem.deployContract("MockERC20", [
      "Stray Token",
      "STRAY",
      18,
    ]);
    const bridgeTxHash = await bridgeHub.read.lastTxHash();

    await viem.assertions.revertWithCustomError(
      gatewayAsOther.write.claimAndRecoverFailedNativeDeposit([
        bridgeTxHash,
        0n,
        0n,
        0,
        [],
      ]),
      gatewayAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      gatewayAsOther.write.recoverClaimedNativeDeposit([bridgeTxHash]),
      gatewayAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      gatewayAsOther.write.recoverUnexpectedNativeToVault([1n]),
      gatewayAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      gatewayAsOther.write.sweepToken([
        strayToken.address,
        other.account.address,
        1n,
      ]),
      gatewayAsOther,
      "Unauthorized",
    );
  });

  it("accepts failed native deposit refunds after the native token vault rotates", async function () {
    const { vault, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);
    await vault.write.setVaultTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 12n });
    await wrappedNative.write.transfer([vault.address, 12n]);

    await vault.write.rebalanceNativeToL2([12n]);

    const bridgeTxHash = await bridgeHub.read.lastTxHash();
    const initialNativeTokenVault = await bridgeHub.read.nativeTokenVault();

    await bridgeHub.write.rotateNativeTokenVault();

    const rotatedNativeTokenVault = await bridgeHub.read.nativeTokenVault();
    assert.notEqual(
      rotatedNativeTokenVault.toLowerCase(),
      initialNativeTokenVault.toLowerCase(),
    );

    await nativeBridgeGateway.write.claimAndRecoverFailedNativeDeposit([
      bridgeTxHash,
      0n,
      0n,
      0,
      [],
    ]);

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 12n);
    assert.equal(
      await publicClient.getBalance({ address: nativeBridgeGateway.address }),
      0n,
    );
  });

  it("rejects re-initializing the native bridge gateway proxy", async function () {
    const {
      vault,
      grvtBridgeProxyFeeToken,
      bridgeHub,
      wrappedNative,
      nativeBridgeGateway,
    } = await deploySystem();

    await viem.assertions.revertWithCustomError(
      nativeBridgeGateway.write.initialize([
        wrappedNative.address,
        grvtBridgeProxyFeeToken.address,
        bridgeHub.address,
        vault.address,
      ]),
      nativeBridgeGateway,
      "InvalidInitialization",
    );
  });

  it("rejects unexpected native ETH sends to native bridge gateway", async function () {
    const { nativeBridgeGateway } = await deploySystem();

    await viem.assertions.revertWithCustomError(
      admin.sendTransaction({
        account: admin.account,
        to: nativeBridgeGateway.address,
        value: 1n,
      }),
      nativeBridgeGateway,
      "UnexpectedNativeSender",
    );
  });

  it("reverts vault fallback on calldata-bearing native sends", async function () {
    const { vault } = await deploySystem();

    await assert.rejects(
      admin.sendTransaction({
        account: admin.account,
        to: vault.address,
        value: 1n,
        data: "0x1234",
      }),
      /revert|reverted|execution reverted/i,
    );
  });
});
