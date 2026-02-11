import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("GRVTDeFiVault rebalance liveness", async function () {
  const { viem } = await network.connect();
  const [admin] = await viem.getWalletClients();
  const supportedTokenConfig = { supported: true };
  const unsupportedTokenConfig = { supported: false };

  async function deploySystem() {
    const baseToken = await viem.deployContract("MockERC20", [
      "Base Token",
      "BASE",
      18,
    ]);
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
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
      ],
    });

    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      admin.account.address,
      initializeData,
    ]);

    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

    return { vault, token, baseToken, bridgeHub };
  }

  it("allows multiple rebalanceToL2 calls without time/size rate limiting", async function () {
    const { vault, token, baseToken, bridgeHub } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await token.write.mint([vault.address, 200n]);

    await vault.write.rebalanceToL2([token.address, 80n]);
    await vault.write.rebalanceToL2([token.address, 40n]);

    assert.equal(await bridgeHub.read.requestCount(), 2n);
    assert.equal(await token.read.balanceOf([vault.address]), 80n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 120n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 2n);
  });

  it("allows emergencySendToL2 while paused and token support is disabled", async function () {
    const { vault, token, baseToken, bridgeHub } = await deploySystem();

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await vault.write.setTokenConfig([token.address, unsupportedTokenConfig]);

    await token.write.mint([vault.address, 75n]);
    await vault.write.pause();

    await vault.write.emergencySendToL2([token.address, 75n]);

    assert.equal(await bridgeHub.read.requestCount(), 1n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await token.read.balanceOf([bridgeHub.address]), 75n);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 1n);
    assert.equal(await vault.read.paused(), true);
  });

  it("reverts rebalanceToL2 while paused", async function () {
    const { vault, token } = await deploySystem();

    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setTokenConfig([token.address, supportedTokenConfig]);
    await token.write.mint([vault.address, 50n]);
    await vault.write.pause();

    await viem.assertions.revertWithCustomError(
      vault.write.rebalanceToL2([token.address, 10n]),
      vault,
      "Paused",
    );
  });

  it("handles base-token bridging branch and clears approvals after calls", async function () {
    const { vault, baseToken, bridgeHub } = await deploySystem();
    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([rebalancerRole, admin.account.address]);

    await vault.write.setTokenConfig([baseToken.address, supportedTokenConfig]);
    await baseToken.write.mint([vault.address, 200n]);

    await vault.write.rebalanceToL2([baseToken.address, 80n]);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 81n);
    assert.equal(await baseToken.read.balanceOf([vault.address]), 120n);
    assert.equal(
      await baseToken.read.allowance([vault.address, bridgeHub.address]),
      0n,
    );

    await vault.write.emergencySendToL2([baseToken.address, 40n]);
    assert.equal(await baseToken.read.balanceOf([bridgeHub.address]), 122n);
    assert.equal(await baseToken.read.balanceOf([vault.address]), 80n);
    assert.equal(
      await baseToken.read.allowance([vault.address, bridgeHub.address]),
      0n,
    );
  });
});
