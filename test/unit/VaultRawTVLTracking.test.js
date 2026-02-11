import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("GRVTDeFiVault raw TVL tracking", async function () {
  const { viem } = await network.connect();
  const [admin] = await viem.getWalletClients();
  const supportedTokenConfig = { supported: true };
  const unsupportedTokenConfig = { supported: false };

  function strategyConfig(whitelisted, cap = 0n) {
    return { whitelisted, active: false, cap };
  }

  async function deploySystem() {
    const baseToken = await viem.deployContract("MockERC20", ["Base Token", "BASE"]);
    const bridgeHub = await viem.deployContract("MockBridgehub", [baseToken.address]);

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
      ],
    });

    const proxy = await viem.deployContract("GRVTTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);

    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);
    return { vault, bridgeHub, baseToken };
  }

  async function deployToken(symbol = "MOCK") {
    return viem.deployContract("MockERC20", [`${symbol} Token`, symbol]);
  }

  async function deployStrategy() {
    return viem.deployContract("MockYieldStrategy");
  }

  it("tracks supported tokens and removes unsupported zero-exposure tokens", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("AAA");

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([token.address]), true);
    assert.deepEqual(
      (await vault.read.getTrackedTokens()).map((a) => a.toLowerCase()),
      [token.address.toLowerCase()],
    );

    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([token.address]), false);
    assert.deepEqual(await vault.read.getTrackedTokens(), []);
  });

  it("keeps unsupported token tracked until idle exposure is drained", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("BBB");

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await token.write.mint([vault.address, 25n]);
    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);

    assert.equal(await vault.read.isTrackedToken([token.address]), true);

    await vault.write.emergencySendToL2([
      token.address,
      25n,
      500_000n,
      800n,
      admin.account.address,
    ]);

    assert.equal(await vault.read.isTrackedToken([token.address]), false);
  });

  it("keeps unsupported token tracked while strategy exposure exists", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("CCC");
    const strategy = await deployStrategy();

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([token.address, 5n]);

    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([token.address]), true);

    await strategy.write.setAssets([token.address, 0n]);
    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      strategyConfig(false),
    ]);

    assert.equal(await vault.read.isTrackedToken([token.address]), false);
  });

  it("returns batch raw totals for provided tokens", async function () {
    const { vault } = await deploySystem();
    const tokenA = await deployToken("DDD");
    const tokenB = await deployToken("EEE");
    const strategy = await deployStrategy();

    await vault.write.setTokenConfig([tokenA.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([tokenB.address, supportedTokenConfig]);
    await tokenA.write.mint([vault.address, 7n]);

    await vault.write.whitelistStrategy([
      tokenB.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([tokenB.address, 3n]);

    const [totals, skipped] = await vault.read.totalAssetsBatch([
      [tokenA.address, tokenB.address],
    ]);
    assert.deepEqual(totals, [7n, 3n]);
    assert.deepEqual(skipped, [0n, 0n]);
  });

  it("skips reverting and overflowing strategy asset reports", async function () {
    const { vault } = await deploySystem();
    const tokenRevert = await deployToken("FFF");
    const tokenOverflow = await deployToken("GGG");
    const strategy = await deployStrategy();

    await vault.write.setTokenConfig([tokenRevert.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([tokenOverflow.address, supportedTokenConfig]);

    await vault.write.whitelistStrategy([
      tokenRevert.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await vault.write.whitelistStrategy([
      tokenOverflow.address,
      strategy.address,
      strategyConfig(true),
    ]);

    await strategy.write.setRevertAssets([tokenRevert.address, true]);
    await strategy.write.setMaxAssets([tokenOverflow.address, true]);
    await tokenOverflow.write.mint([vault.address, 1n]);

    const statusRevert = await vault.read.totalAssetsStatus([tokenRevert.address]);
    assert.equal(statusRevert[0], 0n);
    assert.equal(statusRevert[1], 1n);

    const statusOverflow = await vault.read.totalAssetsStatus([tokenOverflow.address]);
    assert.equal(statusOverflow[0], 1n);
    assert.equal(statusOverflow[1], 1n);

    const [totals, skipped] = await vault.read.totalAssetsBatch([
      [tokenRevert.address, tokenOverflow.address],
    ]);
    assert.deepEqual(totals, [0n, 1n]);
    assert.deepEqual(skipped, [1n, 1n]);
  });
});
