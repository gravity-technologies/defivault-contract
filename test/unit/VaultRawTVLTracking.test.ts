import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("GRVTDeFiVault raw TVL tracking", async function () {
  const { viem } = await network.connect();
  const [admin] = await viem.getWalletClients();
  const supportedTokenConfig = { supported: true };
  const unsupportedTokenConfig = { supported: false };

  function strategyConfig(whitelisted: boolean, cap = 0n) {
    return { whitelisted, active: false, cap };
  }

  async function deploySystem() {
    const baseToken = await viem.deployContract("MockERC20", [
      "Base Token",
      "BASE",
      18,
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
      ],
    });

    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);

    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);
    return { vault, bridgeHub, baseToken };
  }

  async function deployToken(symbol = "MOCK") {
    return viem.deployContract("MockERC20", [`${symbol} Token`, symbol, 18]);
  }

  async function deployStrategy(vault: { address: `0x${string}` }) {
    return viem.deployContract("MockYieldStrategy", [
      vault.address,
      "TVL_STRAT",
    ]);
  }

  it("tracks supported tokens and removes unsupported zero-exposure tokens", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("AAA");

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([token.address]), true);
    assert.deepEqual(
      ((await vault.read.getTrackedTokens()) as Array<`0x${string}`>).map(
        (a: `0x${string}`) => a.toLowerCase(),
      ),
      [token.address.toLowerCase()],
    );

    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([token.address]), false);
    assert.deepEqual(await vault.read.getTrackedTokens(), []);
  });

  it("maintains tracked-token membership after swap-pop removals", async function () {
    const { vault } = await deploySystem();
    const tokenA = await deployToken("HAA");
    const tokenB = await deployToken("HBB");
    const tokenC = await deployToken("HCC");

    await vault.write.setTokenConfig([tokenA.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([tokenB.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([tokenC.address, supportedTokenConfig]);

    const trackedBefore = (
      (await vault.read.getTrackedTokens()) as Array<`0x${string}`>
    ).map((a: `0x${string}`) => a.toLowerCase());
    assert.deepEqual(trackedBefore, [
      tokenA.address.toLowerCase(),
      tokenB.address.toLowerCase(),
      tokenC.address.toLowerCase(),
    ]);

    await vault.write.setTokenConfig([tokenB.address, unsupportedTokenConfig]);
    const trackedAfterB = (
      (await vault.read.getTrackedTokens()) as Array<`0x${string}`>
    ).map((a: `0x${string}`) => a.toLowerCase());
    assert.equal(trackedAfterB.includes(tokenA.address.toLowerCase()), true);
    assert.equal(trackedAfterB.includes(tokenB.address.toLowerCase()), false);
    assert.equal(trackedAfterB.includes(tokenC.address.toLowerCase()), true);
    assert.equal(await vault.read.isTrackedToken([tokenC.address]), true);

    await vault.write.setTokenConfig([tokenC.address, unsupportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([tokenC.address]), false);
    assert.deepEqual(
      ((await vault.read.getTrackedTokens()) as Array<`0x${string}`>).map(
        (a: `0x${string}`) => a.toLowerCase(),
      ),
      [tokenA.address.toLowerCase()],
    );

    const [totals, skipped] = (await vault.read.totalAssetsBatch([
      [tokenA.address, tokenB.address, tokenC.address],
    ])) as [bigint[], bigint[]];
    assert.deepEqual(totals, [0n, 0n, 0n]);
    assert.deepEqual(skipped, [0n, 0n, 0n]);
  });

  it("keeps unsupported token tracked until idle exposure is drained", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("BBB");

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await token.write.mint([vault.address, 25n]);
    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);

    assert.equal(await vault.read.isTrackedToken([token.address]), true);

    await vault.write.emergencySendToL2([token.address, 25n]);

    assert.equal(await vault.read.isTrackedToken([token.address]), false);
  });

  it("keeps unsupported token tracked while strategy exposure exists", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("CCC");
    const strategy = await deployStrategy(vault);

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
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([tokenA.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([tokenB.address, supportedTokenConfig]);
    await tokenA.write.mint([vault.address, 7n]);

    await vault.write.whitelistStrategy([
      tokenB.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([tokenB.address, 3n]);

    const [totals, skipped] = (await vault.read.totalAssetsBatch([
      [tokenA.address, tokenB.address],
    ])) as [bigint[], bigint[]];
    assert.deepEqual(totals, [7n, 3n]);
    assert.deepEqual(skipped, [0n, 0n]);
  });

  it("reverts totalAssetsBatch when token list contains zero address", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("ZZZ");
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await viem.assertions.revertWithCustomError(
      vault.read.totalAssetsBatch([[token.address, zeroAddress]]),
      vault,
      "InvalidParam",
    );
  });

  it("skips reverting and overflowing strategy asset reports", async function () {
    const { vault } = await deploySystem();
    const tokenRevert = await deployToken("FFF");
    const tokenOverflow = await deployToken("GGG");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      tokenRevert.address,
      supportedTokenConfig,
    ]);
    await vault.write.setTokenConfig([
      tokenOverflow.address,
      supportedTokenConfig,
    ]);

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

    const statusRevert = (await vault.read.totalAssetsStatus([
      tokenRevert.address,
    ])) as [bigint, bigint];
    assert.equal(statusRevert[0], 0n);
    assert.equal(statusRevert[1], 1n);

    const statusOverflow = (await vault.read.totalAssetsStatus([
      tokenOverflow.address,
    ])) as [bigint, bigint];
    assert.equal(statusOverflow[0], 1n);
    assert.equal(statusOverflow[1], 1n);

    const [totals, skipped] = (await vault.read.totalAssetsBatch([
      [tokenRevert.address, tokenOverflow.address],
    ])) as [bigint[], bigint[]];
    assert.deepEqual(totals, [0n, 1n]);
    assert.deepEqual(skipped, [1n, 1n]);
  });
});
