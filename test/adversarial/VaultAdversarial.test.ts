import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroHash } from "viem";

describe("GRVTDeFiVault adversarial behavior", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, l2Recipient, treasury] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  async function setupVaultForToken(tokenAddress: `0x${string}`) {
    const bridge = await viem.deployContract("MockBridgeAdapter");
    const vaultImpl = await viem.deployContract("GRVTDeFiVault");
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [addr(admin), bridge.address, addr(l2Recipient)],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);
    const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    await vault.write.grantRole([allocatorRole, addr(allocator)]);
    await vault.write.grantRole([rebalancerRole, addr(rebalancer)]);

    await vault.write.setTokenConfig([
      tokenAddress,
      {
        supported: true,
        idleReserve: 0n,
        rebalanceMaxPerTx: 0n,
        rebalanceMinDelay: 0n,
      },
    ]);

    return { vault, bridge };
  }

  it("blocks reentrancy through malicious strategy callback", async function () {
    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    const { vault } = await setupVaultForToken(token.address);

    await token.write.mint([vault.address, 1_000_000n]);
    const malicious = await viem.deployContract("MockReentrantStrategy", [vault.address, token.address]);

    await vault.write.whitelistStrategy([
      token.address,
      malicious.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);
    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    await vault.write.grantRole([allocatorRole, malicious.address]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });

    await assert.rejects(
      vaultAsAllocator.write.allocateToStrategy([
        token.address,
        malicious.address,
        10_000n,
        "0x",
      ]),
    );
  });

  it("reverts when ERC20 approve/transfer returns false", async function () {
    const badToken = await viem.deployContract("MockFalseReturnERC20");
    const { vault } = await setupVaultForToken(badToken.address);
    await badToken.write.mint([vault.address, 1_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [vault.address, "SAFE_STRAT"]);
    await vault.write.whitelistStrategy([
      badToken.address,
      strategy.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });

    await assert.rejects(
      vaultAsAllocator.write.allocateToStrategy([
        badToken.address,
        strategy.address,
        100_000n,
        "0x",
      ]),
    );
  });

  it("handles fee-on-transfer token with conservative reported received amounts", async function () {
    const feeToken = await viem.deployContract("MockFeeOnTransferERC20", [
      "Fee Token",
      "FEE",
      6,
      100n,
      addr(treasury),
    ]);
    const { vault } = await setupVaultForToken(feeToken.address);
    await feeToken.write.mint([vault.address, 1_000_000n]);

    const strategy = await viem.deployContract("MockYieldStrategy", [vault.address, "FEE_STRAT"]);
    await vault.write.whitelistStrategy([
      feeToken.address,
      strategy.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });

    await vaultAsAllocator.write.allocateToStrategy([
      feeToken.address,
      strategy.address,
      100_000n,
      "0x",
    ]);

    const stratAssets = await vault.read.strategyAssets([feeToken.address, strategy.address]);
    assert.equal(stratAssets, 99_000n);

    await vaultAsAllocator.write.deallocateAllFromStrategy([
      feeToken.address,
      strategy.address,
      "0x",
    ]);
    const finalIdle = await vault.read.idleAssets([feeToken.address]);
    assert.ok(finalIdle < 1_000_000n);
  });
  it("continues emergency unwind when one whitelisted strategy reverts", async function () {
    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    const { vault, bridge } = await setupVaultForToken(token.address);
    await token.write.mint([vault.address, 1_000_000n]);

    const revertingStrategy = await viem.deployContract("MockRevertingStrategy");
    const healthyStrategy = await viem.deployContract("MockYieldStrategy", [vault.address, "HEALTHY"]);

    await vault.write.whitelistStrategy([
      token.address,
      revertingStrategy.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      healthyStrategy.address,
      { whitelisted: true, cap: 0n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });
    const vaultAsRebalancer = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: rebalancer },
    });

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      healthyStrategy.address,
      900_000n,
      "0x",
    ]);

    await vaultAsRebalancer.write.emergencySendToL2([token.address, 400_000n, "0xbeef"]);
    assert.equal(await bridge.read.lastAmount(), 400_000n);
  });
});
