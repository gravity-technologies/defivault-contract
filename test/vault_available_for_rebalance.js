import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

describe("GRVTDeFiVault.availableForRebalance", async function () {
  const { viem } = await network.connect();
  const [admin] = await viem.getWalletClients();

  async function deployVault() {
    const implementation = await viem.deployContract("GRVTDeFiVault");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        admin.account.address,
        "0x0000000000000000000000000000000000000001",
        admin.account.address,
      ],
    });

    const proxy = await viem.deployContract("GRVTTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);

    return viem.getContractAt("GRVTDeFiVault", proxy.address);
  }

  async function deployToken() {
    return viem.deployContract("MockERC20", ["Mock Token", "MOCK"]);
  }

  it("reverts on zero token address", async function () {
    const vault = await deployVault();

    await viem.assertions.revertWithCustomError(
      vault.read.availableForRebalance([zeroAddress]),
      vault,
      "InvalidParam",
    );
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
});
