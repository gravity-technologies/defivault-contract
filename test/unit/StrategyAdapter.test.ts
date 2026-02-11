import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("Aave strategy and zkSync adapter", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, vaultWallet, custodyWallet, otherWallet] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  it("AaveV3Strategy supports vault-only allocate/deallocate flow", async function () {
    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    const aToken = await viem.deployContract("MockAToken");
    const pool = await viem.deployContract("MockAaveV3Pool", [token.address, aToken.address]);
    await aToken.write.setPool([pool.address]);

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const initData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [addr(vaultWallet), pool.address, token.address, aToken.address, "AAVE_USDT"],
    });
    const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      strategyImpl.address,
      addr(admin),
      initData,
    ]);
    const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy.address);

    await token.write.mint([addr(vaultWallet), 1_000_000n]);
    const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    await tokenAsVault.write.approve([strategy.address, 500_000n]);

    const strategyAsVault = await viem.getContractAt("AaveV3Strategy", strategy.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    const strategyAsOther = await viem.getContractAt("AaveV3Strategy", strategy.address, {
      client: { public: publicClient, wallet: otherWallet },
    });

    await strategyAsVault.write.allocate([token.address, 500_000n, "0x"]);
    assert.equal(await strategy.read.assets([token.address]), 500_000n);

    await viem.assertions.revertWithCustomError(
      strategyAsOther.write.allocate([token.address, 10_000n, "0x"]),
      strategyAsOther,
      "Unauthorized",
    );

    await strategyAsVault.write.deallocate([token.address, 200_000n, "0x"]);
    assert.equal(await strategy.read.assets([token.address]), 300_000n);

    await strategyAsVault.write.deallocateAll([token.address, "0x"]);
    assert.equal(await strategy.read.assets([token.address]), 0n);
  });

  it("ZkSyncNativeBridgeAdapter enforces vault caller and custody send", async function () {
    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    const adapterImpl = await viem.deployContract("ZkSyncNativeBridgeAdapter");
    const initData = encodeFunctionData({
      abi: adapterImpl.abi,
      functionName: "initialize",
      args: [addr(admin), addr(vaultWallet), addr(custodyWallet), addr(otherWallet)],
    });
    const adapterProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      adapterImpl.address,
      addr(admin),
      initData,
    ]);
    const adapter = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapterProxy.address);

    await token.write.mint([addr(vaultWallet), 800_000n]);
    const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    await tokenAsVault.write.approve([adapter.address, 300_000n]);

    const adapterAsVault = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapter.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    const adapterAsOther = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapter.address, {
      client: { public: publicClient, wallet: otherWallet },
    });

    await adapterAsVault.write.sendToL2([token.address, 300_000n, addr(custodyWallet), "0x1234"]);
    assert.equal(await token.read.balanceOf([addr(custodyWallet)]), 300_000n);
    assert.equal(await adapter.read.isTrustedInboundCaller([addr(otherWallet)]), true);

    await viem.assertions.revertWithCustomError(
      adapterAsOther.write.sendToL2([token.address, 10_000n, addr(custodyWallet), "0x"]),
      adapterAsOther,
      "Unauthorized",
    );
  });
});
