import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData } from "viem";

describe("AaveV3Strategy", async function () {
  const { viem } = await network.connect();
  const [vault, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  async function deploySystem() {
    const underlying = await viem.deployContract("MockERC20", [
      "Tether USD",
      "USDT",
      6,
    ]);
    const pool = await viem.deployContract("MockAaveV3Pool", [
      underlying.address,
    ]);
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      underlying.address,
      pool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    await pool.write.setAToken([aToken.address]);

    const implementation = await viem.deployContract("AaveV3Strategy");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        pool.address,
        underlying.address,
        aToken.address,
        "AAVE_V3_USDT",
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      vault.account.address,
      initializeData,
    ]);
    const strategy = await viem.getContractAt("AaveV3Strategy", proxy.address);

    const otherToken = await viem.deployContract("MockERC20", [
      "Other Token",
      "OTK",
      18,
    ]);
    return { strategy, underlying, aToken, pool, otherToken };
  }

  async function decodeStrategyLogs(strategy, txHash) {
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

  function findDecodedEvent(logs, eventName) {
    return logs.find((log) => log.eventName === eventName);
  }

  it("reverts initialize when aToken config does not match underlying/pool", async function () {
    const underlying = await viem.deployContract("MockERC20", [
      "Tether USD",
      "USDT",
      6,
    ]);
    const otherUnderlying = await viem.deployContract("MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    const pool = await viem.deployContract("MockAaveV3Pool", [
      underlying.address,
    ]);
    const wrongAToken = await viem.deployContract("MockAaveV3AToken", [
      otherUnderlying.address,
      pool.address,
      "Aave USDC",
      "aUSDC",
    ]);

    const implementation = await viem.deployContract("AaveV3Strategy");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        pool.address,
        underlying.address,
        wrongAToken.address,
        "AAVE_V3_USDT",
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

  it("splits exact-token balances from position breakdowns", async function () {
    const { strategy, underlying, aToken, otherToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 100n]);
    await underlying.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([underlying.address, 100n]);

    let breakdown = await strategy.read.positionBreakdown([underlying.address]);
    assert.equal(breakdown.length, 1);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      aToken.address.toLowerCase(),
    );
    assert.equal(breakdown[0].amount, 100n);
    assert.equal(BigInt(breakdown[0].kind), 0n);

    await underlying.write.mint([strategy.address, 7n], {
      account: outsider.account,
    });

    breakdown = await strategy.read.positionBreakdown([underlying.address]);
    assert.equal(breakdown.length, 2);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      aToken.address.toLowerCase(),
    );
    assert.equal(breakdown[0].amount, 100n);
    assert.equal(BigInt(breakdown[0].kind), 0n);
    assert.equal(
      breakdown[1].token.toLowerCase(),
      underlying.address.toLowerCase(),
    );
    assert.equal(breakdown[1].amount, 7n);
    assert.equal(BigInt(breakdown[1].kind), 1n);

    assert.equal(await strategy.read.exactTokenBalance([aToken.address]), 100n);
    assert.equal(
      await strategy.read.exactTokenBalance([underlying.address]),
      7n,
    );
    assert.equal(
      await strategy.read.exactTokenBalance([otherToken.address]),
      0n,
    );
    const aTokenUnsupportedBreakdown = await strategy.read.positionBreakdown([
      aToken.address,
    ]);
    assert.equal(aTokenUnsupportedBreakdown.length, 0);

    const unsupported = await strategy.read.positionBreakdown([
      otherToken.address,
    ]);
    assert.equal(unsupported.length, 0);
  });

  it("returns strategy-side exposure for the underlying token and 0 for unsupported queries", async function () {
    const { strategy, underlying, otherToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 50n]);
    await underlying.write.approve([strategy.address, 50n]);
    await strategy.write.allocate([underlying.address, 50n]);
    await underlying.write.mint([strategy.address, 2n], {
      account: outsider.account,
    });

    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      52n,
    );
    assert.equal(
      await strategy.read.strategyExposure([otherToken.address]),
      0n,
    );
  });

  it("caps bounded deallocate at the requested total and leaves extra dust for later exits", async function () {
    const { strategy, underlying, aToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 100n]);
    await underlying.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([underlying.address, 100n]);

    await underlying.write.mint([strategy.address, 3n], {
      account: outsider.account,
    });
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      103n,
    );

    const beforePartial = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    const deallocateTx = await strategy.write.deallocate([
      underlying.address,
      40n,
    ]);
    const deallocateLogs = await decodeStrategyLogs(strategy, deallocateTx);
    const afterPartial = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    assert.equal(afterPartial - beforePartial, 40n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 63n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      63n,
    );
    const sweptPartial = deallocateLogs.find(
      (log) => log.eventName === "UninvestedTokenSwept",
    );
    const deallocatedPartial = findDecodedEvent(deallocateLogs, "Deallocated");
    assert.ok(sweptPartial);
    assert.ok(deallocatedPartial);
    assert.equal(
      sweptPartial.args.token.toLowerCase(),
      underlying.address.toLowerCase(),
    );
    assert.equal(sweptPartial.args.amount, 3n);
    assert.equal(
      deallocatedPartial.args.token.toLowerCase(),
      underlying.address.toLowerCase(),
    );
    assert.equal(deallocatedPartial.args.requested, 40n);
    assert.equal(deallocatedPartial.args.received, 40n);

    await underlying.write.mint([strategy.address, 1n], {
      account: outsider.account,
    });
    const beforeAll = await underlying.read.balanceOf([vault.account.address]);
    const deallocateAllTx = await strategy.write.deallocateAll([
      underlying.address,
    ]);
    const deallocateAllLogs = await decodeStrategyLogs(
      strategy,
      deallocateAllTx,
    );
    const afterAll = await underlying.read.balanceOf([vault.account.address]);
    assert.equal(afterAll - beforeAll, 64n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      0n,
    );
    const sweptAll = deallocateAllLogs.find(
      (log) => log.eventName === "UninvestedTokenSwept",
    );
    const deallocatedAll = findDecodedEvent(deallocateAllLogs, "Deallocated");
    assert.ok(sweptAll);
    assert.ok(deallocatedAll);
    assert.equal(sweptAll.args.amount, 1n);
    assert.equal(
      deallocatedAll.args.token.toLowerCase(),
      underlying.address.toLowerCase(),
    );
    assert.equal(deallocatedAll.args.requested, 2n ** 256n - 1n);
    assert.equal(deallocatedAll.args.received, 64n);
  });

  it("sweeps dust-only underlying after the Aave position is already fully exited", async function () {
    const { strategy, underlying, aToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 100n]);
    await underlying.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([underlying.address, 100n]);
    await strategy.write.deallocateAll([underlying.address]);

    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);

    await underlying.write.mint([strategy.address, 2n], {
      account: outsider.account,
    });
    const beforeSweepAll = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    const sweepAllTx = await strategy.write.deallocateAll([underlying.address]);
    const sweepAllLogs = await decodeStrategyLogs(strategy, sweepAllTx);
    const afterSweepAll = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    assert.equal(afterSweepAll - beforeSweepAll, 2n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      0n,
    );
    const sweptAll = findDecodedEvent(sweepAllLogs, "UninvestedTokenSwept");
    const deallocatedAll = findDecodedEvent(sweepAllLogs, "Deallocated");
    assert.ok(sweptAll);
    assert.ok(deallocatedAll);
    assert.equal(sweptAll.args.amount, 2n);
    assert.equal(deallocatedAll.args.requested, 2n ** 256n - 1n);
    assert.equal(deallocatedAll.args.received, 2n);

    await underlying.write.mint([strategy.address, 3n], {
      account: outsider.account,
    });
    const beforeSweepBounded = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    const sweepBoundedTx = await strategy.write.deallocate([
      underlying.address,
      1n,
    ]);
    const sweepBoundedLogs = await decodeStrategyLogs(strategy, sweepBoundedTx);
    const afterSweepBounded = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    assert.equal(afterSweepBounded - beforeSweepBounded, 1n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 2n);
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      2n,
    );
    const sweptBounded = findDecodedEvent(
      sweepBoundedLogs,
      "UninvestedTokenSwept",
    );
    const deallocatedBounded = findDecodedEvent(
      sweepBoundedLogs,
      "Deallocated",
    );
    assert.ok(sweptBounded);
    assert.ok(deallocatedBounded);
    assert.equal(sweptBounded.args.amount, 1n);
    assert.equal(deallocatedBounded.args.requested, 1n);
    assert.equal(deallocatedBounded.args.received, 1n);

    const beforeRemainingSweep = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    await strategy.write.deallocateAll([underlying.address]);
    const afterRemainingSweep = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    assert.equal(afterRemainingSweep - beforeRemainingSweep, 2n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      0n,
    );
  });

  it("can satisfy a bounded request entirely from loose underlying while leaving aTokens untouched", async function () {
    const { strategy, underlying, aToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 100n]);
    await underlying.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([underlying.address, 100n]);

    await underlying.write.mint([strategy.address, 5n], {
      account: outsider.account,
    });

    const beforeVault = await underlying.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.deallocate([underlying.address, 3n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await underlying.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 3n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 100n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 2n);
    assert.equal(
      await strategy.read.strategyExposure([underlying.address]),
      102n,
    );

    const swept = findDecodedEvent(logs, "UninvestedTokenSwept");
    const deallocated = findDecodedEvent(logs, "Deallocated");
    assert.ok(swept);
    assert.ok(deallocated);
    assert.equal(swept.args.amount, 3n);
    assert.equal(deallocated.args.requested, 3n);
    assert.equal(deallocated.args.received, 3n);
  });

  it("enforces onlyVault on mutating methods", async function () {
    const { strategy, underlying } = await deploySystem();

    await assert.rejects(
      strategy.write.allocate([underlying.address, 1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.deallocate([underlying.address, 1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.deallocateAll([underlying.address], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
  });

  it("reverts on wrong-token and zero-amount inputs", async function () {
    const { strategy, underlying, otherToken } = await deploySystem();

    await assert.rejects(
      strategy.write.allocate([otherToken.address, 1n]),
      /InvalidParam/,
    );
    await assert.rejects(
      strategy.write.allocate([underlying.address, 0n]),
      /InvalidParam/,
    );
    await assert.rejects(
      strategy.write.deallocate([otherToken.address, 1n]),
      /InvalidParam/,
    );
    await assert.rejects(
      strategy.write.deallocate([underlying.address, 0n]),
      /InvalidParam/,
    );
    await assert.rejects(
      strategy.write.deallocateAll([otherToken.address]),
      /InvalidParam/,
    );
  });
});
