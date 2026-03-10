import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData } from "viem";

import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("GRVTL1TreasuryVault raw TVL tracking", async function () {
  const { viem } = await network.connect();
  const [admin, yieldRecipient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
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

  async function decodeVaultLogs(
    vault: { address: `0x${string}`; abi: readonly unknown[] },
    txHash: `0x${string}`,
  ): Promise<Array<{ eventName: string; args: Record<string, unknown> }>> {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    return receipt.logs
      .filter(
        (log) => log.address.toLowerCase() === vault.address.toLowerCase(),
      )
      .map((log) => {
        try {
          return decodeEventLog({
            abi: vault.abi,
            data: log.data,
            topics: log.topics,
          });
        } catch {
          return null;
        }
      })
      .filter(
        (
          decoded,
        ): decoded is { eventName: string; args: Record<string, unknown> } =>
          decoded !== null,
      );
  }

  it("tracks supported tokens and removes unsupported zero-exposure tokens", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("AAA");

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      true,
    );
    assert.deepEqual(
      (await vault.read.getTrackedPrincipalTokens()).map((a) =>
        a.toLowerCase(),
      ),
      [token.address.toLowerCase()],
    );

    await vault.write.setPrincipalTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      false,
    );
    assert.deepEqual(await vault.read.getTrackedPrincipalTokens(), []);
  });

  it("keeps unsupported token tracked until idle exposure is drained", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("BBB");

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await token.write.mint([vault.address, 25n]);
    await vault.write.setPrincipalTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);

    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      true,
    );

    await vault.write.emergencyErc20ToL2([token.address, 25n]);

    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      false,
    );
  });

  it("keeps unsupported token tracked while strategy exposure exists", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("CCC");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([token.address, 5n]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      true,
    );

    await strategy.write.setAssets([token.address, 0n]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(false),
    ]);

    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      false,
    );
  });

  it("supports break-glass root tracking override for strategy-read failure pinning", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("PIN");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([token.address, 5n]);
    await strategy.write.setRevertAssets([token.address, true]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      unsupportedTokenConfig,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      true,
    );

    await vault.write.setTrackedPrincipalOverride([token.address, true, false]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      false,
    );

    await vault.write.setTrackedPrincipalOverride([
      token.address,
      false,
      false,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([token.address]),
      true,
    );
  });

  it("returns batch raw totals for provided tokens", async function () {
    const { vault } = await deploySystem();
    const tokenA = await deployToken("DDD");
    const tokenB = await deployToken("EEE");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      tokenA.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalTokenConfig([
      tokenB.address,
      supportedTokenConfig,
    ]);
    await tokenA.write.mint([vault.address, 7n]);

    await vault.write.setPrincipalStrategyWhitelist([
      tokenB.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([tokenB.address, 3n]);

    const statuses = await vault.read.totalExactAssetsBatch([
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

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([receiptToken.address, 9n]);

    assert.deepEqual(
      await vault.read.getPrincipalTokenStrategies([receiptToken.address]),
      [],
    );

    const totals = await vault.read.totalExactAssets([receiptToken.address]);
    assert.equal(totals.idle, 0n);
    assert.equal(totals.strategy, 9n);
    assert.equal(totals.total, 9n);

    const status = await vault.read.totalExactAssetsStatus([
      receiptToken.address,
    ]);
    assert.equal(status.total, 9n);
    assert.equal(status.skippedStrategies, 0n);
  });

  it("does not include component-token exposure in principal-token tracking discovery", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("UKY");
    const receiptToken = await deployToken("RCP");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    // Configure component set before strategy activation so whitelist sync captures it.
    await strategy.write.setComponents([
      underlying.address,
      [receiptToken.address],
      [11n],
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    // Keep direct receipt query non-zero as well.
    await strategy.write.setAssets([receiptToken.address, 11n]);

    const tracked = (await vault.read.getTrackedPrincipalTokens()).map(
      (token) => token.toLowerCase(),
    );
    assert.equal(tracked.includes(underlying.address.toLowerCase()), true);
    assert.equal(tracked.includes(receiptToken.address.toLowerCase()), false);

    const statuses = await vault.read.totalExactAssetsBatch([
      [receiptToken.address],
    ]);
    assert.equal(statuses[0].total, 11n);
  });

  it("does not track residual underlying-only components as separate component tokens", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("RSU");
    const receiptToken = await deployToken("RSR");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await strategy.write.setComponents([
      underlying.address,
      [underlying.address],
      [8n],
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    const tracked = (await vault.read.getTrackedPrincipalTokens()).map(
      (token) => token.toLowerCase(),
    );
    assert.equal(tracked.includes(underlying.address.toLowerCase()), true);
    assert.equal(tracked.includes(receiptToken.address.toLowerCase()), false);
  });

  it("getTrackedPrincipalTokens does not call strategy assets at read time and remains principal-only", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("QKY");
    const receiptToken = await deployToken("QRC");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await strategy.write.setComponents([
      underlying.address,
      [receiptToken.address],
      [4n],
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    await strategy.write.setRevertAssets([underlying.address, true]);
    const tracked = (await vault.read.getTrackedPrincipalTokens()).map(
      (token) => token.toLowerCase(),
    );
    assert.equal(tracked.includes(underlying.address.toLowerCase()), true);
    assert.equal(tracked.includes(receiptToken.address.toLowerCase()), false);
  });

  it("keeps principal-token tracking stable through allocate/deallocate hooks", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("WTY");
    const receiptToken = await deployToken("WRC");
    const strategy = await deployStrategy(vault);

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, admin.account.address]);

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([underlying.address]),
      true,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptToken.address]),
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

    await vault.write.allocatePrincipalToStrategy([
      underlying.address,
      strategy.address,
      1n,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([underlying.address]),
      true,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptToken.address]),
      false,
    );

    await strategy.write.setComponents([underlying.address, [], []]);
    await vault.write.deallocatePrincipalFromStrategy([
      underlying.address,
      strategy.address,
      1n,
    ]);
    assert.equal(
      await vault.read.isTrackedPrincipalToken([underlying.address]),
      true,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptToken.address]),
      false,
    );
  });

  it("ignores non-principal multi-token component shape for tracked-principal discovery", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("MSU");
    const receiptA = await deployToken("MSA");
    const receiptB = await deployToken("MSB");
    const receiptC = await deployToken("MSC");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await strategy.write.setComponents([
      underlying.address,
      [receiptA.address],
      [5n],
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    assert.equal(
      await vault.read.isTrackedPrincipalToken([underlying.address]),
      true,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptA.address]),
      false,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptB.address]),
      false,
    );

    await strategy.write.setComponents([
      underlying.address,
      [receiptB.address, receiptC.address],
      [4n, 3n],
    ]);
    // Existing whitelisted entry update triggers write-time component sync.
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);

    assert.equal(
      await vault.read.isTrackedPrincipalToken([underlying.address]),
      true,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptA.address]),
      false,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptB.address]),
      false,
    );
    assert.equal(
      await vault.read.isTrackedPrincipalToken([receiptC.address]),
      false,
    );
  });

  it("keeps strategyPositionBreakdown consistent with global totalExactAssets for component-token queries", async function () {
    const { vault } = await deploySystem();
    const underlying = await deployToken("SKY");
    const receiptToken = await deployToken("SRC");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      underlying.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      underlying.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([receiptToken.address, 6n]);

    const breakdown = await vault.read.strategyPositionBreakdown([
      receiptToken.address,
      strategy.address,
    ]);
    assert.equal(breakdown.components.length, 1);
    assert.equal(
      breakdown.components[0].token.toLowerCase(),
      receiptToken.address.toLowerCase(),
    );
    assert.equal(breakdown.components[0].amount, 6n);

    const totals = await vault.read.totalExactAssets([receiptToken.address]);
    assert.equal(totals.strategy, 6n);
    assert.equal(totals.total, 6n);
  });

  it("normalizes strategyPositionBreakdown read failures to InvalidStrategyAssetsRead", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("ERR");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setRevertAssets([token.address, true]);

    await viem.assertions.revertWithCustomError(
      vault.read.strategyPositionBreakdown([token.address, strategy.address]),
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

    await vault.write.setPrincipalTokenConfig([
      tokenA.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalTokenConfig([
      tokenB.address,
      supportedTokenConfig,
    ]);

    await vault.write.setPrincipalStrategyWhitelist([
      tokenA.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      tokenB.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setAssets([receiptToken.address, 13n]);

    const totals = await vault.read.totalExactAssets([receiptToken.address]);
    assert.equal(totals.strategy, 13n);
    assert.equal(totals.total, 13n);

    const statuses = await vault.read.totalExactAssetsBatch([
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

    await vault.write.setPrincipalTokenConfig([
      tokenRevert.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalTokenConfig([
      tokenOverflow.address,
      supportedTokenConfig,
    ]);

    await vault.write.setPrincipalStrategyWhitelist([
      tokenRevert.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      tokenOverflow.address,
      strategy.address,
      strategyConfig(true),
    ]);

    await strategy.write.setRevertAssets([tokenRevert.address, true]);
    await strategy.write.setMaxAssets([tokenOverflow.address, true]);
    await tokenOverflow.write.mint([vault.address, 1n]);

    const statusRevert = await vault.read.totalExactAssetsStatus([
      tokenRevert.address,
    ]);
    assert.equal(statusRevert.total, 0n);
    assert.equal(statusRevert.skippedStrategies, 1n);

    const statusOverflow = await vault.read.totalExactAssetsStatus([
      tokenOverflow.address,
    ]);
    assert.equal(statusOverflow.total, 1n);
    assert.equal(statusOverflow.skippedStrategies, 1n);

    const statuses = await vault.read.totalExactAssetsBatch([
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

  it("updates cap while remaining whitelisted on repeated whitelist", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("LC1");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true, 10n),
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true, 77n),
    ]);

    const cfg = await vault.read.getPrincipalStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(cfg.whitelisted, true);
    assert.equal(cfg.active, true);
    assert.equal(cfg.cap, 77n);
  });

  it("moves strategy into withdraw-only when de-whitelisted with remaining exposure", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("LC2");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true, 90n),
    ]);
    await strategy.write.setAssets([token.address, 5n]);

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(false, 33n),
    ]);

    const cfg = await vault.read.getPrincipalStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, true);
    assert.equal(cfg.cap, 33n);
    const tokenStrategies = await vault.read.getPrincipalTokenStrategies([
      token.address,
    ]);
    assert.equal(
      tokenStrategies
        .map((a) => a.toLowerCase())
        .includes(strategy.address.toLowerCase()),
      true,
    );
  });

  it("updates withdraw-only cap on repeated de-whitelist calls", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("LC3");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true, 100n),
    ]);
    await strategy.write.setAssets([token.address, 9n]);

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(false, 40n),
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(false, 12n),
    ]);

    const cfg = await vault.read.getPrincipalStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, true);
    assert.equal(cfg.cap, 12n);
  });

  it("emits StrategyRemovalCheckFailed and stays withdraw-only when exposure probe reverts", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("LC4");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await strategy.write.setRevertAssets([token.address, true]);

    const txHash = await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(false, 55n),
    ]);
    const logs = await decodeVaultLogs(vault, txHash);
    const removalCheckFailed = logs.find(
      (log) => log.eventName === "StrategyRemovalCheckFailed",
    );
    assert.ok(removalCheckFailed);

    const cfg = await vault.read.getPrincipalStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, true);
    assert.equal(cfg.cap, 55n);
  });

  it("removes strategy from registry when de-whitelisted after exposure is zero", async function () {
    const { vault } = await deploySystem();
    const token = await deployToken("LC5");
    const strategy = await deployStrategy(vault);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true, 10n),
    ]);
    await strategy.write.setAssets([token.address, 0n]);

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(false),
    ]);

    const cfg = await vault.read.getPrincipalStrategyConfig([
      token.address,
      strategy.address,
    ]);
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, false);
    assert.equal(cfg.cap, 0n);
    const tokenStrategies = await vault.read.getPrincipalTokenStrategies([
      token.address,
    ]);
    assert.equal(
      tokenStrategies
        .map((a) => a.toLowerCase())
        .includes(strategy.address.toLowerCase()),
      false,
    );
    assert.equal(
      await vault.read.isStrategyWhitelistedForPrincipal([
        token.address,
        strategy.address,
      ]),
      false,
    );
  });
});
