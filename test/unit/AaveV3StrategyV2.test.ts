import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData } from "viem";

describe("AaveV3StrategyV2", async function () {
  const { viem } = await network.connect();
  const [vault, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  async function deploySystem() {
    const vaultToken = await viem.deployContract("MockERC20", [
      "Tether USD",
      "USDT",
      6,
    ]);
    const pool = await viem.deployContract("MockAaveV3Pool", [
      vaultToken.address,
    ]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultToken.address,
      pool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    await pool.write.setAToken([aToken.address]);

    const implementation = await viem.deployContract("AaveV3StrategyV2");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      vault.account.address,
    ]);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        pool.address,
        vaultToken.address,
        aToken.address,
        "AAVE_V3_USDT_V2",
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

    const otherToken = await viem.deployContract("MockERC20", [
      "Other Token",
      "OTK",
      18,
    ]);
    return { beacon, strategy, vaultToken, aToken, pool, otherToken };
  }

  async function decodeStrategyLogs(strategy: any, txHash: `0x${string}`) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    return receipt.logs
      .filter(
        (log) => log.address.toLowerCase() === strategy.address.toLowerCase(),
      )
      .map((log) => {
        try {
          return decodeEventLog({
            abi: strategy.abi,
            data: log.data,
            topics: log.topics,
          });
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function findDecodedEvent(logs: any[], eventName: string) {
    return logs.find((log) => log.eventName === eventName);
  }

  it("reverts initialize when aToken config does not match vault token or pool", async function () {
    const vaultToken = await viem.deployContract("MockERC20", [
      "Tether USD",
      "USDT",
      6,
    ]);
    const otherToken = await viem.deployContract("MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    const pool = await viem.deployContract("MockAaveV3Pool", [
      vaultToken.address,
    ]);
    const wrongAToken = await viem.deployContract("MockAaveV3AToken", [
      otherToken.address,
      pool.address,
      "Aave USDC",
      "aUSDC",
    ]);

    const implementation = await viem.deployContract("AaveV3StrategyV2");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      vault.account.address,
    ]);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        pool.address,
        vaultToken.address,
        wrongAToken.address,
        "AAVE_V3_USDT_V2",
      ],
    });

    await assert.rejects(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      /InvalidATokenConfig/,
    );
  });

  it("reports the V2 marker, lane token, balances, and strategy value", async function () {
    const { strategy, beacon, vaultToken, aToken, otherToken } =
      await deploySystem();

    assert.equal(
      (await beacon.read.owner()).toLowerCase(),
      vault.account.address.toLowerCase(),
    );

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);
    await vaultToken.write.mint([strategy.address, 7n], {
      account: outsider.account,
    });

    assert.equal(await strategy.read.isYieldStrategyV2(), "0xa42fe856");
    assert.equal(
      (await strategy.read.vaultToken()).toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
    assert.equal(await strategy.read.totalExposure(), 107n);
    assert.equal(await strategy.read.exactTokenBalance([aToken.address]), 100n);
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      7n,
    );
    assert.equal(
      await strategy.read.exactTokenBalance([otherToken.address]),
      0n,
    );

    const breakdown = await strategy.read.positionBreakdown();
    assert.equal(breakdown.length, 2);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      aToken.address.toLowerCase(),
    );
    assert.equal(
      breakdown[1].token.toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
  });

  it("reports zero exposure, zero balances, and an empty breakdown before funding", async function () {
    const { strategy, vaultToken, aToken, otherToken } = await deploySystem();

    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([aToken.address]), 0n);
    assert.equal(
      await strategy.read.exactTokenBalance([otherToken.address]),
      0n,
    );

    const breakdown = await strategy.read.positionBreakdown();
    assert.equal(breakdown.length, 0);
  });

  it("reuses the same family beacon for a second lane", async function () {
    const { strategy, beacon } = await deploySystem();

    const secondVaultToken = await viem.deployContract("MockERC20", [
      "Other Token",
      "OTK",
      18,
    ]);
    const secondPool = await viem.deployContract("MockAaveV3Pool", [
      secondVaultToken.address,
    ]);
    const secondAToken = await viem.deployContract("MockAaveV3AToken", [
      secondVaultToken.address,
      secondPool.address,
      "Aave Other Token",
      "aOTK",
    ]);
    await secondPool.write.setAToken([secondAToken.address]);

    const secondInitializeData = encodeFunctionData({
      abi: strategy.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        secondPool.address,
        secondVaultToken.address,
        secondAToken.address,
        "AAVE_V3_OTK_V2",
      ],
    });
    const secondProxy = await viem.deployContract("TestBeaconProxy", [
      beacon.address,
      secondInitializeData,
    ]);
    const secondStrategy = await viem.getContractAt(
      "AaveV3StrategyV2",
      secondProxy.address,
    );

    assert.equal(
      (await secondStrategy.read.vaultToken()).toLowerCase(),
      secondVaultToken.address.toLowerCase(),
    );
    assert.equal(await secondStrategy.read.totalExposure(), 0n);
    assert.equal(
      (await beacon.read.owner()).toLowerCase(),
      vault.account.address.toLowerCase(),
    );
  });

  it("withdraws direct vault-token first and then Aave liquidity", async function () {
    const { strategy, vaultToken, aToken, pool } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);
    await vaultToken.write.mint([strategy.address, 3n], {
      account: outsider.account,
    });
    await pool.write.accrueYield([strategy.address, 10n]);

    assert.equal(await strategy.read.totalExposure(), 113n);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdraw([6n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 6n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 107n);
    assert.equal(await strategy.read.totalExposure(), 107n);

    const withdrawn = findDecodedEvent(logs, "Withdrawn") as any;
    assert.ok(withdrawn);
    assert.equal(withdrawn.args.requested, 6n);
    assert.equal(withdrawn.args.received, 6n);
  });

  it("exposes residual underlying from a partial-fill pool and reports both legs", async function () {
    const vaultToken = await viem.deployContract("MockERC20", [
      "Tether USD",
      "USDT",
      6,
    ]);
    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3PoolPartialFill", [
      vaultToken.address,
      aToken.address,
      5_000,
    ]);
    await aToken.write.setUnderlyingAsset([vaultToken.address]);
    await aToken.write.setPool([pool.address]);
    const implementation = await viem.deployContract("AaveV3StrategyV2");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      vault.account.address,
    ]);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        pool.address,
        vaultToken.address,
        aToken.address,
        "AAVE_V3_USDT_V2_PARTIAL",
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

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    assert.equal(await strategy.read.totalExposure(), 100n);
    assert.equal(await strategy.read.exactTokenBalance([aToken.address]), 50n);
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      50n,
    );

    const breakdown = await strategy.read.positionBreakdown();
    assert.equal(breakdown.length, 2);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      aToken.address.toLowerCase(),
    );
    assert.equal(breakdown[0].amount, 50n);
    assert.equal(
      breakdown[1].token.toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
    assert.equal(breakdown[1].amount, 50n);
  });

  it("caps withdrawal at available exposure when the request is larger than the lane", async function () {
    const { strategy, vaultToken, aToken } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);
    await vaultToken.write.mint([strategy.address, 3n], {
      account: outsider.account,
    });

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdraw([500n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 103n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.totalExposure(), 0n);

    const withdrawn = findDecodedEvent(logs, "Withdrawn") as any;
    assert.ok(withdrawn);
    assert.equal(withdrawn.args.requested, 500n);
    assert.equal(withdrawn.args.received, 103n);
  });

  it("withdraws direct dust only when the request is covered without touching Aave", async function () {
    const { strategy, vaultToken, aToken, pool } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);
    await vaultToken.write.mint([strategy.address, 4n], {
      account: outsider.account,
    });
    await pool.write.accrueYield([strategy.address, 8n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const beforeAToken = await aToken.read.balanceOf([strategy.address]);
    const txHash = await strategy.write.withdraw([3n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 3n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 1n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), beforeAToken);
    assert.equal(await strategy.read.totalExposure(), 109n);

    const withdrawn = findDecodedEvent(logs, "Withdrawn") as any;
    assert.ok(withdrawn);
    assert.equal(withdrawn.args.requested, 3n);
    assert.equal(withdrawn.args.received, 3n);
  });

  it("enforces onlyVault and rejects zero-amount operations", async function () {
    const { strategy } = await deploySystem();

    await assert.rejects(
      strategy.write.allocate([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.withdraw([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(strategy.write.allocate([0n]), /InvalidParam/);
    await assert.rejects(strategy.write.withdraw([0n]), /InvalidParam/);
  });
});
