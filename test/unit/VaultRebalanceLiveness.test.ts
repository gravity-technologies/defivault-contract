import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault rebalance liveness", async function () {
  const { viem } = await network.connect();
  const [admin, yieldRecipient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const supportedTokenConfig = { supported: true };
  const unsupportedTokenConfig = { supported: false };

  async function deploySystem({
    setNativeBridgeGateway = true,
  }: { setNativeBridgeGateway?: boolean } = {}) {
    const baseToken = await viem.deployContract("MockERC20", [
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
      baseToken.address,
    ]);

    const { vaultImplementation: implementation } =
      await deployVaultImplementation(viem);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        admin.account.address,
        bridgeHub.address,
        baseToken.address,
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
        baseToken.address,
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
      baseToken,
      bridgeHub,
      wrappedNative,
      nativeBridgeGateway,
    };
  }

  it("allows multiple rebalanceErc20ToL2 calls without time/size rate limiting", async function () {
    const { vault, token, baseToken, bridgeHub } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await token.write.mint([vault.address, 200n]);

    await vault.write.rebalanceErc20ToL2([token.address, 80n]);
    await vault.write.rebalanceErc20ToL2([token.address, 40n]);

    assert.equal(await bridgeHub.read.requestCount(), 2n);
    assert.equal(await token.read.balanceOf([vault.address]), 80n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 120n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 2n);
  });

  it("allows emergencyErc20ToL2 while paused and token support is disabled", async function () {
    const { vault, token, baseToken, bridgeHub } = await deploySystem();

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);

    await token.write.mint([vault.address, 75n]);
    await vault.write.pause();

    await vault.write.emergencyErc20ToL2([token.address, 75n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 75n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 1n);
    assert.equal(await vault.read.paused(), true);
  });

  it("reverts rebalanceErc20ToL2 while paused", async function () {
    const { vault, token } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await token.write.mint([vault.address, 50n]);
    await vault.write.pause();

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceErc20ToL2([token.address, 10n]),
      vault,
      "Paused",
    );
  });

  it("routes native rebalance through native bridge branch", async function () {
    const { vault, baseToken, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 20n });
    await wrappedNative.write.transfer([vault.address, 20n]);

    await vault.write.rebalanceNativeToL2([12n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastToken(), zeroAddress);
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
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 1n);
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

    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      unsupportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 9n });
    await wrappedNative.write.transfer([vault.address, 9n]);
    await vault.write.pause();

    await vault.write.emergencyNativeToL2([9n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastToken(), zeroAddress);
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
    await vault.write.setPrincipalTokenConfig([
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

  it("supports canonical external native ingress via NativeVaultGateway", async function () {
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

  it("wraps an externally claimed failed native deposit back to the vault", async function () {
    const { vault, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);
    await vault.write.setPrincipalTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit({ value: 12n });
    await wrappedNative.write.transfer([vault.address, 12n]);

    await vault.write.rebalanceNativeToL2([12n]);

    const bridgeTxHash = await bridgeHub.read.lastTxHash();
    await bridgeHub.write.claimFailedDeposit([
      270n,
      nativeBridgeGateway.address,
      zeroAddress,
      12n,
      bridgeTxHash,
      0n,
      0n,
      0,
      [],
    ]);
    await nativeBridgeGateway.write.recoverClaimedNativeDeposit([bridgeTxHash]);

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

  it("rejects re-initializing the native bridge gateway proxy", async function () {
    const { vault, baseToken, bridgeHub, wrappedNative, nativeBridgeGateway } =
      await deploySystem();

    await viem.assertions.revertWithCustomError(
      nativeBridgeGateway.write.initialize([
        wrappedNative.address,
        baseToken.address,
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
