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
    const wrappedNative = await viem.deployContract("MockERC20", [
      "Wrapped Ether",
      "WETH",
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
        wrappedNative.address,
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

  it("supports break-glass root tracking override for strategy-read failure pinning", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("PIN");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([token.address, 5n]);
    await strategy.write.setRevertAssets([token.address, true]);

    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);
    assert.equal(await vault.read.isTrackedToken([token.address]), true);

    await vault.write.setRootTrackingOverride([token.address, true, false]);
    assert.equal(await vault.read.isTrackedToken([token.address]), false);

    await vault.write.setRootTrackingOverride([token.address, false, false]);
    assert.equal(await vault.read.isTrackedToken([token.address]), true);
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

    const statuses = await vault.read.totalAssetsBatch([
      [tokenA.address, tokenB.address],
    ]);
    assert.deepEqual(
      statuses.map((status) => status.total),
      [7n, 3n],
    );
    assert.deepEqual(
      statuses.map((status) => status.skippedStrategies),
      [0n, 0n],
    );
  });

  it("supports non-underlying token queries via global active strategy index", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("HHH");
    const receiptToken = await deployToken("AUS");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([receiptToken.address, 9n]);

    assert.deepEqual(
      await vault.read.getTokenStrategies([receiptToken.address]),
      [],
    );

    const totals = await vault.read.totalAssets([receiptToken.address]);
    assert.equal(totals.idle, 0n);
    assert.equal(totals.strategy, 9n);
    assert.equal(totals.total, 9n);

    const status = await vault.read.totalAssetsStatus([receiptToken.address]);
    assert.equal(status.total, 9n);
    assert.equal(status.skippedStrategies, 0n);
  });

  it("includes component-token exposure in getTrackedTokens via write-time sync hooks", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("UKY");
    const receiptToken = await deployToken("RCP");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    // Configure component set before strategy activation so whitelist sync captures it.
    await strategy.write.setComponents([
      underlying.address,
      [receiptToken.address],
      [11n],
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    // Keep direct receipt query non-zero as well.
    await strategy.write.setAssets([receiptToken.address, 11n]);

    const tracked = (await vault.read.getTrackedTokens()).map((token) =>
      token.toLowerCase(),
    );
    assert.equal(tracked.includes(underlying.address.toLowerCase()), true);
    assert.equal(tracked.includes(receiptToken.address.toLowerCase()), true);

    const statuses = await vault.read.totalAssetsBatch([
      [receiptToken.address],
    ]);
    assert.equal(statuses[0].total, 11n);
  });

  it("does not track residual underlying-only components as separate component tokens", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("RSU");
    const receiptToken = await deployToken("RSR");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await strategy.write.setComponents([
      underlying.address,
      [underlying.address],
      [8n],
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    const tracked = (await vault.read.getTrackedTokens()).map((token) =>
      token.toLowerCase(),
    );
    assert.equal(tracked.includes(underlying.address.toLowerCase()), true);
    assert.equal(tracked.includes(receiptToken.address.toLowerCase()), false);
  });

  it("getTrackedTokens does not call strategy assets at read time", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("QKY");
    const receiptToken = await deployToken("QRC");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await strategy.write.setComponents([
      underlying.address,
      [receiptToken.address],
      [4n],
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    await strategy.write.setRevertAssets([underlying.address, true]);
    const tracked = (await vault.read.getTrackedTokens()).map((token) =>
      token.toLowerCase(),
    );
    assert.equal(tracked.includes(underlying.address.toLowerCase()), true);
    assert.equal(tracked.includes(receiptToken.address.toLowerCase()), true);
  });

  it("updates component-token tracked membership through allocate/deallocate hooks", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("WTY");
    const receiptToken = await deployToken("WRC");
    const strategy = await deployStrategy(vault);

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, admin.account.address]);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    assert.equal(
      await vault.read.isTrackedToken([receiptToken.address]),
      false,
    );

    await strategy.write.setComponents([
      underlying.address,
      [receiptToken.address],
      [1n],
    ]);
    // Keep strategy token balance consistent with mock scalar before allocation.
    await underlying.write.mint([strategy.address, 1n]);
    await underlying.write.mint([vault.address, 1n]);

    await vault.write.allocateToStrategy([
      underlying.address,
      strategy.address,
      1n,
    ]);
    assert.equal(await vault.read.isTrackedToken([receiptToken.address]), true);

    await strategy.write.setComponents([underlying.address, [], []]);
    await vault.write.deallocateFromStrategy([
      underlying.address,
      strategy.address,
      1n,
    ]);
    assert.equal(
      await vault.read.isTrackedToken([receiptToken.address]),
      false,
    );
  });

  it("uses first non-root position token on unsupported multi-token shape", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("MSU");
    const receiptA = await deployToken("MSA");
    const receiptB = await deployToken("MSB");
    const receiptC = await deployToken("MSC");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await strategy.write.setComponents([
      underlying.address,
      [receiptA.address],
      [5n],
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    assert.equal(await vault.read.isTrackedToken([receiptA.address]), true);
    assert.equal(await vault.read.isTrackedToken([receiptB.address]), false);

    await strategy.write.setComponents([
      underlying.address,
      [receiptB.address, receiptC.address],
      [4n, 3n],
    ]);
    // Existing whitelisted entry update triggers write-time component sync.
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    assert.equal(await vault.read.isTrackedToken([receiptA.address]), false);
    assert.equal(await vault.read.isTrackedToken([receiptB.address]), true);
    assert.equal(await vault.read.isTrackedToken([receiptC.address]), false);
  });

  it("keeps strategyAssets consistent with global totalAssets for component-token queries", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("SKY");
    const receiptToken = await deployToken("SRC");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await vault.write.whitelistStrategy([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([receiptToken.address, 6n]);

    const breakdown = await vault.read.strategyAssets([
      receiptToken.address,
      strategy.address,
    ]);
    assert.equal(breakdown.components.length, 1);
    assert.equal(
      breakdown.components[0].token.toLowerCase(),
      receiptToken.address.toLowerCase(),
    );
    assert.equal(breakdown.components[0].amount, 6n);

    const totals = await vault.read.totalAssets([receiptToken.address]);
    assert.equal(totals.strategy, 6n);
    assert.equal(totals.total, 6n);
  });

  it("normalizes strategyAssets read failures to InvalidStrategyAssetsRead", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("ERR");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await vault.write.whitelistStrategy([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setRevertAssets([token.address, true]);

    await viem.assertions.revertWithCustomError(
      vault.read.strategyAssets([token.address, strategy.address]),
      vault,
      "InvalidStrategyAssetsRead",
    );
  });

  it("deduplicates strategy scans when one strategy is active under multiple token keys", async function () {
    const { vault } = await deploySystem();
    const tokenA = await deployToken("III");
    const tokenB = await deployToken("JJJ");
    const receiptToken = await deployToken("AKK");
    const strategy = await deployStrategy(vault);

    await vault.write.setTokenConfig([tokenA.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([tokenB.address, supportedTokenConfig]);

    await vault.write.whitelistStrategy([
      tokenA.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await vault.write.whitelistStrategy([
      tokenB.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([receiptToken.address, 13n]);

    const totals = await vault.read.totalAssets([receiptToken.address]);
    assert.equal(totals.strategy, 13n);
    assert.equal(totals.total, 13n);

    const statuses = await vault.read.totalAssetsBatch([
      [receiptToken.address],
    ]);
    assert.equal(statuses[0].total, 13n);
    assert.equal(statuses[0].skippedStrategies, 0n);
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

    const statusRevert = await vault.read.totalAssetsStatus([
      tokenRevert.address,
    ]);
    assert.equal(statusRevert.total, 0n);
    assert.equal(statusRevert.skippedStrategies, 1n);

    const statusOverflow = await vault.read.totalAssetsStatus([
      tokenOverflow.address,
    ]);
    assert.equal(statusOverflow.total, 1n);
    assert.equal(statusOverflow.skippedStrategies, 1n);

    const statuses = await vault.read.totalAssetsBatch([
      [tokenRevert.address, tokenOverflow.address],
    ]);
    assert.deepEqual(
      statuses.map((status) => status.total),
      [0n, 1n],
    );
    assert.deepEqual(
      statuses.map((status) => status.skippedStrategies),
      [1n, 1n],
    );
  });
});
