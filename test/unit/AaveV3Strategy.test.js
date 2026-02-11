import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData } from "viem";

describe("AaveV3Strategy", async function () {
  const { viem } = await network.connect();
  const [vault, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  async function deploySystem() {
    const underlying = await viem.deployContract("MockERC20", ["Tether USD", "USDT", 6]);
    const pool = await viem.deployContract("MockAaveV3Pool", [underlying.address]);
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

    const otherToken = await viem.deployContract("MockERC20", ["Other Token", "OTK", 18]);
    return { strategy, underlying, aToken, pool, otherToken };
  }

  async function decodeStrategyLogs(strategy, txHash) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    return receipt.logs
      .filter((log) => log.address.toLowerCase() === strategy.address.toLowerCase())
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

  it("reverts initialize when aToken config does not match underlying/pool", async function () {
    const underlying = await viem.deployContract("MockERC20", ["Tether USD", "USDT", 6]);
    const otherUnderlying = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const pool = await viem.deployContract("MockAaveV3Pool", [underlying.address]);
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

  it("reports structured components for underlying and aToken query domains", async function () {
    const { strategy, underlying, aToken, otherToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 100n]);
    await underlying.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([underlying.address, 100n]);

    let breakdown = await strategy.read.assets([underlying.address]);
    assert.equal(breakdown.components.length, 1);
    assert.equal(breakdown.components[0].token.toLowerCase(), aToken.address.toLowerCase());
    assert.equal(breakdown.components[0].amount, 100n);
    assert.equal(BigInt(breakdown.components[0].kind), 0n);

    await underlying.write.mint([strategy.address, 7n], { account: outsider.account });

    breakdown = await strategy.read.assets([underlying.address]);
    assert.equal(breakdown.components.length, 2);
    assert.equal(breakdown.components[0].token.toLowerCase(), aToken.address.toLowerCase());
    assert.equal(breakdown.components[0].amount, 100n);
    assert.equal(BigInt(breakdown.components[0].kind), 0n);
    assert.equal(breakdown.components[1].token.toLowerCase(), underlying.address.toLowerCase());
    assert.equal(breakdown.components[1].amount, 7n);
    assert.equal(BigInt(breakdown.components[1].kind), 1n);

    const aTokenBreakdown = await strategy.read.assets([aToken.address]);
    assert.equal(aTokenBreakdown.components.length, 1);
    assert.equal(aTokenBreakdown.components[0].token.toLowerCase(), aToken.address.toLowerCase());
    assert.equal(aTokenBreakdown.components[0].amount, 100n);

    const unsupported = await strategy.read.assets([otherToken.address]);
    assert.equal(unsupported.components.length, 0);
  });

  it("returns principal-bearing scalar in underlying domain and 0 for unsupported domains", async function () {
    const { strategy, underlying, otherToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 50n]);
    await underlying.write.approve([strategy.address, 50n]);
    await strategy.write.allocate([underlying.address, 50n]);
    await underlying.write.mint([strategy.address, 2n], { account: outsider.account });

    assert.equal(await strategy.read.principalBearingExposure([underlying.address]), 52n);
    assert.equal(await strategy.read.principalBearingExposure([otherToken.address]), 0n);
  });

  it("sweeps residual underlying on deallocate and deallocateAll to prevent dust-lock exposure", async function () {
    const { strategy, underlying, aToken } = await deploySystem();

    await underlying.write.mint([vault.account.address, 100n]);
    await underlying.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([underlying.address, 100n]);

    await underlying.write.mint([strategy.address, 3n], { account: outsider.account });
    assert.equal(await strategy.read.principalBearingExposure([underlying.address]), 103n);

    const beforePartial = await underlying.read.balanceOf([vault.account.address]);
    const deallocateTx = await strategy.write.deallocate([underlying.address, 40n]);
    const deallocateLogs = await decodeStrategyLogs(strategy, deallocateTx);
    const afterPartial = await underlying.read.balanceOf([vault.account.address]);
    assert.equal(afterPartial - beforePartial, 43n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 60n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.principalBearingExposure([underlying.address]), 60n);
    const sweptPartial = deallocateLogs.find((log) => log.eventName === "ResidualUnderlyingSwept");
    assert.ok(sweptPartial);
    assert.equal(sweptPartial.args.token.toLowerCase(), underlying.address.toLowerCase());
    assert.equal(sweptPartial.args.amount, 3n);

    await underlying.write.mint([strategy.address, 1n], { account: outsider.account });
    const beforeAll = await underlying.read.balanceOf([vault.account.address]);
    const deallocateAllTx = await strategy.write.deallocateAll([underlying.address]);
    const deallocateAllLogs = await decodeStrategyLogs(strategy, deallocateAllTx);
    const afterAll = await underlying.read.balanceOf([vault.account.address]);
    assert.equal(afterAll - beforeAll, 61n);
    assert.equal(await aToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await underlying.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.principalBearingExposure([underlying.address]), 0n);
    const sweptAll = deallocateAllLogs.find((log) => log.eventName === "ResidualUnderlyingSwept");
    assert.ok(sweptAll);
    assert.equal(sweptAll.args.amount, 1n);
  });

  it("enforces onlyVault on mutating methods", async function () {
    const { strategy, underlying } = await deploySystem();

    await assert.rejects(
      strategy.write.allocate([underlying.address, 1n], { account: outsider.account }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.deallocate([underlying.address, 1n], { account: outsider.account }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.deallocateAll([underlying.address], { account: outsider.account }),
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
