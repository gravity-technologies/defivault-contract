import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("AaveV3Strategy", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, vaultWallet, otherWallet] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  it("initializes with matching aToken metadata and supports vault-only operations", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3Pool", [
      token.address,
      aToken.address,
    ]);

    await aToken.write.setUnderlyingAsset([token.address]);
    await aToken.write.setPool([pool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const initData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [
        addr(vaultWallet),
        pool.address,
        token.address,
        aToken.address,
        "AAVE_USDT",
      ],
    });
    const strategyProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [strategyImpl.address, addr(admin), initData],
    );
    const strategy = await viem.getContractAt(
      "AaveV3Strategy",
      strategyProxy.address,
    );

    assert.equal(
      ((await strategy.read.vault()) as `0x${string}`).toLowerCase(),
      addr(vaultWallet).toLowerCase(),
    );
    assert.equal(
      ((await strategy.read.underlying()) as `0x${string}`).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      ((await strategy.read.aToken()) as `0x${string}`).toLowerCase(),
      aToken.address.toLowerCase(),
    );

    await token.write.mint([addr(vaultWallet), 1_000_000n]);
    const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    await tokenAsVault.write.approve([strategy.address, 500_000n]);

    const strategyAsVault = await viem.getContractAt(
      "AaveV3Strategy",
      strategy.address,
      {
        client: { public: publicClient, wallet: vaultWallet },
      },
    );
    const strategyAsOther = await viem.getContractAt(
      "AaveV3Strategy",
      strategy.address,
      {
        client: { public: publicClient, wallet: otherWallet },
      },
    );

    await strategyAsVault.write.allocate([token.address, 500_000n]);
    await token.write.mint([strategy.address, 123n]);

    assert.equal(await strategy.read.assets([token.address]), 500_123n);

    await viem.assertions.revertWithCustomError(
      strategyAsOther.write.deallocate([token.address, 1n]),
      strategyAsOther,
      "Unauthorized",
    );

    await strategyAsVault.write.deallocate([token.address, 200_000n]);
    assert.equal(await strategy.read.assets([token.address]), 300_123n);

    await strategyAsVault.write.deallocateAll([token.address]);
    assert.equal(await strategy.read.assets([token.address]), 123n);
  });

  it("reflects mocked yield accrual in assets()", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3Pool", [
      token.address,
      aToken.address,
    ]);

    await aToken.write.setUnderlyingAsset([token.address]);
    await aToken.write.setPool([pool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const initData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [
        addr(vaultWallet),
        pool.address,
        token.address,
        aToken.address,
        "AAVE_YIELD",
      ],
    });
    const strategyProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [strategyImpl.address, addr(admin), initData],
    );
    const strategy = await viem.getContractAt(
      "AaveV3Strategy",
      strategyProxy.address,
    );

    await token.write.mint([addr(vaultWallet), 500_000n]);
    const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    await tokenAsVault.write.approve([strategy.address, 500_000n]);

    const strategyAsVault = await viem.getContractAt(
      "AaveV3Strategy",
      strategy.address,
      {
        client: { public: publicClient, wallet: vaultWallet },
      },
    );

    await strategyAsVault.write.allocate([token.address, 200_000n]);
    const before = (await strategy.read.assets([token.address])) as bigint;

    await pool.write.accrueYield([strategy.address, 10_000n]);
    const after = (await strategy.read.assets([token.address])) as bigint;

    assert.equal(after - before, 10_000n);
  });

  it("reverts initialize when aToken underlying does not match", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const wrongToken = await viem.deployContract("MockERC20", [
      "Other",
      "OTH",
      6,
    ]);
    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3Pool", [
      token.address,
      aToken.address,
    ]);

    await aToken.write.setUnderlyingAsset([token.address]);
    await aToken.write.setPool([pool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      strategyImpl.address,
      addr(admin),
      "0x",
    ]);
    const strategyAsVault = await viem.getContractAt(
      "AaveV3Strategy",
      proxy.address,
      {
        client: { public: publicClient, wallet: vaultWallet },
      },
    );

    await viem.assertions.revertWithCustomError(
      strategyAsVault.write.initialize([
        addr(vaultWallet),
        pool.address,
        wrongToken.address,
        aToken.address,
        "AAVE_BAD_UNDERLYING",
      ]),
      strategyAsVault,
      "InvalidATokenConfig",
    );
  });

  it("reverts initialize when aToken pool does not match", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3Pool", [
      token.address,
      aToken.address,
    ]);

    await aToken.write.setUnderlyingAsset([token.address]);
    await aToken.write.setPool([pool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      strategyImpl.address,
      addr(admin),
      "0x",
    ]);
    const strategyAsVault = await viem.getContractAt(
      "AaveV3Strategy",
      proxy.address,
      {
        client: { public: publicClient, wallet: vaultWallet },
      },
    );

    await viem.assertions.revertWithCustomError(
      strategyAsVault.write.initialize([
        addr(vaultWallet),
        addr(otherWallet),
        token.address,
        aToken.address,
        "AAVE_BAD_POOL",
      ]),
      strategyAsVault,
      "InvalidATokenConfig",
    );
  });

  it("reverts allocate on partial-fill pool due to residual underlying", async function () {
    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    const aToken = await viem.deployContract("MockAToken");
    const partialPool = await viem.deployContract("MockAaveV3PoolPartialFill", [
      token.address,
      aToken.address,
      5_000,
    ]);

    await aToken.write.setUnderlyingAsset([token.address]);
    await aToken.write.setPool([partialPool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const initData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [
        addr(vaultWallet),
        partialPool.address,
        token.address,
        aToken.address,
        "AAVE_PARTIAL",
      ],
    });
    const strategyProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [strategyImpl.address, addr(admin), initData],
    );
    const strategy = await viem.getContractAt(
      "AaveV3Strategy",
      strategyProxy.address,
    );

    await token.write.mint([addr(vaultWallet), 100_000n]);
    const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    const strategyAsVault = await viem.getContractAt(
      "AaveV3Strategy",
      strategy.address,
      {
        client: { public: publicClient, wallet: vaultWallet },
      },
    );

    await tokenAsVault.write.approve([strategy.address, 100_000n]);

    await viem.assertions.revertWithCustomError(
      strategyAsVault.write.allocate([token.address, 100_000n]),
      strategyAsVault,
      "ResidualUnderlyingAfterSupply",
    );
  });
});
