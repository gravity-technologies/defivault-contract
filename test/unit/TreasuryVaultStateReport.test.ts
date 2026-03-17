import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import {
  buildTreasuryVaultStateReport,
  eventCategory,
  lifecycleLabel,
  trackedTokenSourceLabel,
} from "../../scripts/report/treasury-vault-state-lib.js";
import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

describe("treasury vault state report helpers", function () {
  it("maps lifecycle labels deterministically", function () {
    assert.equal(
      lifecycleLabel({ whitelisted: true, active: true, cap: 0n }),
      "active",
    );
    assert.equal(
      lifecycleLabel({ whitelisted: false, active: true, cap: 0n }),
      "withdraw-only",
    );
    assert.equal(
      lifecycleLabel({ whitelisted: false, active: false, cap: 0n }),
      "removed",
    );
    assert.equal(
      lifecycleLabel({ whitelisted: true, active: false, cap: 0n }),
      "unexpected",
    );
  });

  it("classifies tracked token source labels", function () {
    assert.equal(
      trackedTokenSourceLabel({ supported: true, strategyDeclared: false }),
      "supported",
    );
    assert.equal(
      trackedTokenSourceLabel({ supported: false, strategyDeclared: true }),
      "strategy-declared",
    );
    assert.equal(
      trackedTokenSourceLabel({ supported: true, strategyDeclared: true }),
      "supported + strategy-declared",
    );
    assert.equal(
      trackedTokenSourceLabel({ supported: false, strategyDeclared: false }),
      "unknown / possible override",
    );
  });

  it("uses the fixed event categories", function () {
    assert.equal(
      eventCategory("VaultTokenStrategyConfigUpdated"),
      "Lifecycle & Config",
    );
    assert.equal(
      eventCategory("VaultTokenDeallocatedFromStrategy"),
      "Allocations & Deallocations",
    );
    assert.equal(eventCategory("YieldHarvested"), "Yield");
    assert.equal(eventCategory("BridgeSentToL2"), "Bridge & Emergency");
    assert.equal(
      eventCategory("StrategyReportedReceivedMismatch"),
      "Warnings & Anomalies",
    );
  });
});

describe("buildTreasuryVaultStateReport", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [admin, yieldRecipient] = await viem.getWalletClients();

  async function deploySystem() {
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
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
      grvtBridgeProxyFeeToken.address,
    ]);
    const { vaultImplementation } = await deployVaultImplementation(viem);
    const initializeData = encodeFunctionData({
      abi: vaultImplementation.abi,
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
      vaultImplementation.address,
      admin.account.address,
      initializeData,
    ]);
    const vault = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      proxy.address,
    );
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "USDT",
      6,
    ]);
    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "MOCK_YIELD_USDT",
    ]);

    await vault.write.setVaultTokenConfig([token.address, { supported: true }]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 123_000_000n },
    ]);
    await token.write.mint([vault.address, 50_000_000n]);
    await strategy.write.setAssets([token.address, 25_000_000n]);
    await strategy.write.setRevertAssets([token.address, true]);

    return { strategy, token, vault };
  }

  it("renders a markdown report with degraded-read warnings and event sections", async function () {
    const { vault, token, strategy } = await deploySystem();
    const latestBlock = await publicClient.getBlockNumber();

    const report = await buildTreasuryVaultStateReport({
      chainId: 31337,
      fromBlock: 0n,
      maxEventsPerCategory: 5,
      networkName: "hardhat",
      publicClient,
      toBlock: latestBlock,
      vaultAbi: vault.abi,
      vaultAddress: vault.address,
    });

    assert.match(report.markdown, /# Treasury Vault State/);
    assert.match(report.markdown, /## Warnings/);
    assert.match(report.markdown, /Metadata unavailable|Tracked TVL token/);
    assert.match(report.markdown, /## Vault Summary/);
    assert.match(report.markdown, /## Supported Vault Tokens/);
    assert.match(report.markdown, /USDT/);
    assert.match(report.markdown, /## Tracked TVL/);
    assert.match(report.markdown, /lower bound/);
    assert.match(report.markdown, /## Strategies/);
    assert.match(report.markdown, new RegExp(strategy.address, "i"));
    assert.match(report.markdown, /Degraded reads:/);
    assert.match(report.markdown, /## Significant Historical Events/);
    assert.match(report.markdown, /Lifecycle & Config/);
    assert.match(report.markdown, /VaultTokenStrategyConfigUpdated/);
    assert.ok(report.warnings.length > 0, "expected at least one warning");
    assert.ok(
      report.warnings.some(
        (warning) =>
          warning.includes("lower bound") || warning.includes("degraded"),
      ),
      "expected lower-bound or degraded warning",
    );
  });
});
