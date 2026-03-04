import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

describe("GRVTDeFiVault.availableForRebalance", async function () {
  const { viem } = await network.connect();
  const [admin] = await viem.getWalletClients();

  async function deployVault() {
    const baseToken = await viem.deployContract("MockERC20", [
      "Base Token",
      "BASE",
    ]);
    const wrappedNative = await viem.deployContract("MockERC20", [
      "Wrapped Ether",
      "WETH",
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

    return viem.getContractAt("GRVTDeFiVault", proxy.address);
  }

  async function deployToken() {
    return viem.deployContract("MockERC20", ["Mock Token", "MOCK"]);
  }

  async function deployNonErc20Contract() {
    return viem.deployContract("MockNonERC20");
  }

  it("returns 0 on zero token address", async function () {
    const vault = await deployVault();

    assert.equal(await vault.read.availableForRebalance([zeroAddress]), 0n);
  });

  it("returns 0 for unsupported token even if vault holds balance", async function () {
    const vault = await deployVault();
    const token = await deployToken();

    await token.write.mint([vault.address, 50n]);

    assert.equal(await vault.read.availableForRebalance([token.address]), 0n);
  });

  it("returns full idle balance for supported token", async function () {
    const vault = await deployVault();
    const token = await deployToken();

    await token.write.mint([vault.address, 123n]);
    await vault.write.setTokenConfig([token.address, { supported: true }]);

    assert.equal(await vault.read.availableForRebalance([token.address]), 123n);
  });

  it("returns 0 for supported token with zero idle balance", async function () {
    const vault = await deployVault();
    const token = await deployToken();

    await vault.write.setTokenConfig([token.address, { supported: true }]);

    assert.equal(await vault.read.availableForRebalance([token.address]), 0n);
  });

  it("reverts setTokenConfig for EOA token addresses", async function () {
    const vault = await deployVault();

    await assert.rejects(
      vault.write.setTokenConfig([admin.account.address, { supported: true }]),
      /InvalidParam/,
    );
  });

  it("reverts setTokenConfig for non-ERC20 contracts", async function () {
    const vault = await deployVault();
    const nonErc20 = await deployNonErc20Contract();

    await assert.rejects(
      vault.write.setTokenConfig([nonErc20.address, { supported: true }]),
      /InvalidParam/,
    );
  });
});
