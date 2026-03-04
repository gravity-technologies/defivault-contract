import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

describe("GRVTDeFiVault rebalance liveness", async function () {
  const { viem } = await network.connect();
  const [admin] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const supportedTokenConfig = { supported: true };
  const unsupportedTokenConfig = { supported: false };

  async function deploySystem() {
    const baseToken = await viem.deployContract("MockERC20", [
      "Base Token",
      "BASE",
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
    ]);
    const bridgeHub = await viem.deployContract("MockBridgehub", [
      baseToken.address,
    ]);

    const implementation = await viem.deployContract("GRVTDeFiVault");
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
      ],
    });

    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);

    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

    return { vault, token, baseToken, bridgeHub, wrappedNative };
  }

  it("allows multiple rebalanceToL2 calls without time/size rate limiting", async function () {
    const { vault, token, baseToken, bridgeHub } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await token.write.mint([vault.address, 200n]);

    await vault.write.rebalanceToL2([token.address, 80n]);
    await vault.write.rebalanceToL2([token.address, 40n]);

    assert.equal(await bridgeHub.read.requestCount(), 2n);
    assert.equal(await token.read.balanceOf([vault.address]), 80n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 120n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 2n);
  });

  it("allows emergencySendToL2 while paused and token support is disabled", async function () {
    const { vault, token, baseToken, bridgeHub } = await deploySystem();

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);

    await token.write.mint([vault.address, 75n]);
    await vault.write.pause();

    await vault.write.emergencySendToL2([token.address, 75n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 75n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 1n);
    assert.equal(await vault.read.paused(), true);
  });

  it("reverts rebalanceToL2 while paused", async function () {
    const { vault, token } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await token.write.mint([vault.address, 50n]);
    await vault.write.pause();

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceToL2([token.address, 10n]),
      vault,
      "Paused",
    );
  });

  it("routes ETH sentinel rebalance through native bridge branch", async function () {
    const { vault, baseToken, bridgeHub, wrappedNative } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await wrappedNative.write.deposit([], { value: 20n });
    await wrappedNative.write.transfer([vault.address, 20n]);

    await vault.write.rebalanceToL2([zeroAddress, 12n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastToken(), zeroAddress);
    assert.equal(await bridgeHub.read.lastAmount(), 12n);
    assert.equal(await bridgeHub.read.lastSecondBridgeValue(), 12n);
    assert.equal(await bridgeHub.read.lastMsgValue(), 12n);
    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 8n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 1n);
    assert.equal(
      await publicClient.getBalance({ address: bridgeHub.address }),
      12n,
    );
  });

  it("rejects explicit wrapped native token bridge-out", async function () {
    const { vault, wrappedNative } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceToL2([wrappedNative.address, 1n]),
      vault,
      "InvalidParam",
    );
  });

  it("routes ETH sentinel emergency sends through native bridge branch", async function () {
    const { vault, bridgeHub, wrappedNative } = await deploySystem();

    await vault.write.setTokenConfig([
      wrappedNative.address,
      supportedTokenConfig,
    ]);
    await vault.write.setTokenConfig([
      wrappedNative.address,
      unsupportedTokenConfig,
    ]);
    await wrappedNative.write.deposit([], { value: 9n });
    await wrappedNative.write.transfer([vault.address, 9n]);
    await vault.write.pause();

    await vault.write.emergencySendToL2([zeroAddress, 9n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await bridgeHub.read.lastToken(), zeroAddress);
    assert.equal(await bridgeHub.read.lastSecondBridgeValue(), 9n);
    assert.equal(await bridgeHub.read.lastMsgValue(), 9n);
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

  it("supports canonical external native ingress via NativeToWrappedIngress", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const ingress = await viem.deployContract("NativeToWrappedIngress", [
      wrappedNative.address,
      vault.address,
    ]);

    await admin.sendTransaction({
      account: admin.account,
      to: ingress.address,
      value: 6n,
    });

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 6n);
    assert.equal(await wrappedNative.read.balanceOf([ingress.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: ingress.address }),
      0n,
    );
  });

  it("supports explicit ingress() calls on NativeToWrappedIngress", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const ingress = await viem.deployContract("NativeToWrappedIngress", [
      wrappedNative.address,
      vault.address,
    ]);

    await ingress.write.ingress([], { value: 4n });

    assert.equal(await wrappedNative.read.balanceOf([vault.address]), 4n);
    assert.equal(await wrappedNative.read.balanceOf([ingress.address]), 0n);
    assert.equal(
      await publicClient.getBalance({ address: ingress.address }),
      0n,
    );
  });

  it("rejects zero-value ingress wrapper calls", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const ingress = await viem.deployContract("NativeToWrappedIngress", [
      wrappedNative.address,
      vault.address,
    ]);

    await viem.assertions.revertWithCustomError(
      ingress.write.ingress([], { value: 0n }),
      ingress,
      "InvalidParam",
    );
  });

  it("rejects calldata-bearing native sends to ingress wrapper", async function () {
    const { vault, wrappedNative } = await deploySystem();
    const ingress = await viem.deployContract("NativeToWrappedIngress", [
      wrappedNative.address,
      vault.address,
    ]);

    await viem.assertions.revertWithCustomError(
      admin.sendTransaction({
        account: admin.account,
        to: ingress.address,
        value: 1n,
        data: "0x1234",
      }),
      ingress,
      "InvalidParam",
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
