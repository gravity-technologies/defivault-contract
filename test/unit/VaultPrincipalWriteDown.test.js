import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData } from "viem";

describe("GRVTL1TreasuryVault principal write-down", async function () {
  const { viem } = await network.connect();
  const [admin, yieldRecipient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const supportedTokenConfig = { supported: true };

  function strategyConfig(whitelisted, cap = 0n) {
    return { whitelisted, active: false, cap };
  }

  async function deploySystem() {
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

    const implementation = await viem.deployContract("GRVTL1TreasuryVault");
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
    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "PWD_STRAT",
    ]);
    return { vault, token, strategy };
  }

  async function decodeVaultLogs(vault, txHash) {
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
      .filter(Boolean);
  }

  async function bootstrapPosition(vault, token, strategy, amount) {
    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, admin.account.address]);
    await vault.write.setPrincipalTokenConfig([
      token.address,
      supportedTokenConfig,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      strategy.address,
      strategyConfig(true),
    ]);
    await token.write.mint([vault.address, amount]);
    await vault.write.allocatePrincipalToStrategy([
      token.address,
      strategy.address,
      amount,
    ]);
  }

  it("emits StrategyPrincipalWrittenDown after unwind when exposure is lower than tracked principal", async function () {
    const { vault, token, strategy } = await deploySystem();
    await bootstrapPosition(vault, token, strategy, 10n);

    await strategy.write.setAssets([token.address, 4n]);
    const txHash = await vault.write.deallocatePrincipalFromStrategy([
      token.address,
      strategy.address,
      1n,
    ]);
    const logs = await decodeVaultLogs(vault, txHash);

    const writeDown = logs.find(
      (log) => log.eventName === "StrategyPrincipalWrittenDown",
    );
    assert.ok(writeDown);
    assert.equal(
      writeDown.args.principalToken.toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      writeDown.args.strategy.toLowerCase(),
      strategy.address.toLowerCase(),
    );
    assert.equal(writeDown.args.previousPrincipal, 9n);
    assert.equal(writeDown.args.newPrincipal, 3n);
    assert.equal(writeDown.args.exposureAfter, 3n);
  });

  it("emits StrategyPrincipalWriteDownSkipped when post-unwind exposure read fails", async function () {
    const { vault, token, strategy } = await deploySystem();
    await bootstrapPosition(vault, token, strategy, 10n);

    await strategy.write.setRevertAssets([token.address, true]);
    const txHash = await vault.write.deallocatePrincipalFromStrategy([
      token.address,
      strategy.address,
      1n,
    ]);
    const logs = await decodeVaultLogs(vault, txHash);

    const skipped = logs.find(
      (log) => log.eventName === "StrategyPrincipalWriteDownSkipped",
    );
    assert.ok(skipped);
    assert.equal(
      skipped.args.principalToken.toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      skipped.args.strategy.toLowerCase(),
      strategy.address.toLowerCase(),
    );
  });
});
