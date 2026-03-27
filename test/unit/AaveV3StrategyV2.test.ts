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
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      vault.account.address,
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
    return { strategy, vaultToken, aToken, pool, otherToken };
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
      viem.deployContract("TestTransparentUpgradeableProxy", [
        implementation.address,
        vault.account.address,
        initializeData,
      ]),
      /InvalidATokenConfig/,
    );
  });

  it("reports the V2 marker, lane token, balances, and residual exposure", async function () {
    const { strategy, vaultToken, aToken, otherToken } = await deploySystem();

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

    assert.equal(await strategy.read.strategyExposure(), 107n);
    assert.equal(await strategy.read.residualExposure(), 7n);
  });

  it("withdrawTracked ignores residual balances and reports zero reimbursement", async function () {
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
    const txHash = await strategy.write.withdrawTracked([40n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 40n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 60n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 3n);
    assert.equal(await strategy.read.residualExposure(), 3n);

    const deallocated = findDecodedEvent(logs, "Deallocated") as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 40n);
    assert.equal(deallocated.args.reimbursableFee, 0n);
  });

  it("withdrawResidual realizes direct residual token and invested yield without touching tracked value", async function () {
    const { strategy, vaultToken, aToken, pool } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    await vaultToken.write.mint([strategy.address, 2n], {
      account: outsider.account,
    });
    await vaultToken.write.mint([pool.address, 10n], {
      account: outsider.account,
    });
    await pool.write.accrueYield([strategy.address, 10n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawResidual([6n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 6n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 106n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure(), 106n);
    assert.equal(await strategy.read.residualExposure(), 6n);

    const deallocated = findDecodedEvent(logs, "Deallocated") as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 6n);
    assert.equal(deallocated.args.reimbursableFee, 0n);
  });

  it("withdrawAllTracked leaves residual value behind for a later residual sweep", async function () {
    const { strategy, vaultToken, aToken, pool } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    await vaultToken.write.mint([strategy.address, 2n], {
      account: outsider.account,
    });
    await vaultToken.write.mint([pool.address, 5n], {
      account: outsider.account,
    });
    await pool.write.accrueYield([strategy.address, 5n]);

    const beforeTracked = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const trackedTxHash = await strategy.write.withdrawAllTracked();
    const trackedLogs = await decodeStrategyLogs(strategy, trackedTxHash);
    const afterTracked = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);

    assert.equal(afterTracked - beforeTracked, 100n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 5n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 2n);
    assert.equal(await strategy.read.strategyExposure(), 7n);
    assert.equal(await strategy.read.residualExposure(), 7n);

    const trackedDeallocated = findDecodedEvent(
      trackedLogs,
      "Deallocated",
    ) as any;
    assert.ok(trackedDeallocated);
    assert.equal(trackedDeallocated.args.received, 100n);
    assert.equal(trackedDeallocated.args.reimbursableFee, 0n);

    const beforeResidual = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const residualTxHash = await strategy.write.withdrawAllResidual();
    const residualLogs = await decodeStrategyLogs(strategy, residualTxHash);
    const afterResidual = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);

    assert.equal(afterResidual - beforeResidual, 7n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure(), 0n);
    assert.equal(await strategy.read.residualExposure(), 0n);

    const residualDeallocated = findDecodedEvent(
      residualLogs,
      "Deallocated",
    ) as any;
    assert.ok(residualDeallocated);
    assert.equal(residualDeallocated.args.received, 7n);
    assert.equal(residualDeallocated.args.reimbursableFee, 0n);
  });

  it("treats direct aToken transfers as residual-only value", async function () {
    const { strategy, vaultToken, aToken, pool } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    await vaultToken.write.mint([pool.address, 4n], {
      account: outsider.account,
    });
    await pool.write.accrueYield([outsider.account.address, 4n], {
      account: outsider.account,
    });
    await aToken.write.transfer([strategy.address, 4n], {
      account: outsider.account,
    });

    assert.equal(await strategy.read.residualExposure(), 4n);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    await strategy.write.withdrawAllResidual();
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 4n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 100n);
    assert.equal(await strategy.read.residualExposure(), 0n);
  });

  it("enforces onlyVault and rejects zero-amount tracked/residual exits", async function () {
    const { strategy } = await deploySystem();

    await assert.rejects(
      strategy.write.allocate([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.withdrawTracked([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.withdrawResidual([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(strategy.write.allocate([0n]), /InvalidParam/);
    await assert.rejects(strategy.write.withdrawTracked([0n]), /InvalidParam/);
    await assert.rejects(strategy.write.withdrawResidual([0n]), /InvalidParam/);
  });
});
