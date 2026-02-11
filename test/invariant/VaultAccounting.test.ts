import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroHash } from "viem";

describe("GRVTDeFiVault accounting invariant", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, l2Recipient] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  function mulberry32(seed: number) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("keeps totalAssets consistent with idle + strategies across random sequences", async function () {
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

    const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
    await token.write.mint([vault.address, 3_000_000n]);

    const stratA = await viem.deployContract("MockYieldStrategy", [vault.address, "STRAT_A"]);
    const stratB = await viem.deployContract("MockYieldStrategy", [vault.address, "STRAT_B"]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 0n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 0n,
      },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: true, cap: 2_000_000n, tag: zeroHash },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      stratB.address,
      { whitelisted: true, cap: 2_000_000n, tag: zeroHash },
    ]);

    await vault.write.grantRole([await vault.read.ALLOCATOR_ROLE(), addr(allocator)]);
    await vault.write.grantRole([await vault.read.REBALANCER_ROLE(), addr(rebalancer)]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });
    const vaultAsRebalancer = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: rebalancer },
    });

    const rng = mulberry32(42);
    const strategies = [stratA.address, stratB.address];

    for (let i = 0; i < 30; i++) {
      const action = Math.floor(rng() * 3);

      if (action === 0) {
        const idle = await vault.read.idleAssets([token.address]);
        const strategy = strategies[Math.floor(rng() * strategies.length)];
        const current = await vault.read.strategyAssets([token.address, strategy]);
        const remainingCap = 2_000_000n > current ? 2_000_000n - current : 0n;
        let amount = idle / 10n;
        if (amount > remainingCap) amount = remainingCap;
        if (amount > 0n) {
          await vaultAsAllocator.write.allocateToStrategy([token.address, strategy, amount, "0x"]);
        }
      } else if (action === 1) {
        const strategy = strategies[Math.floor(rng() * strategies.length)];
        const sAssets = await vault.read.strategyAssets([token.address, strategy]);
        const amount = sAssets / 2n;
        if (amount > 0n) {
          await vaultAsAllocator.write.deallocateFromStrategy([token.address, strategy, amount, "0x"]);
        }
      } else {
        const available = await vault.read.availableForRebalance([token.address]);
        let amount = available / 5n;
        if (amount > 500_000n) amount = 500_000n;
        if (amount > 0n) {
          await vaultAsRebalancer.write.rebalanceToL2([token.address, amount, "0x"]);
        }
      }

      const idle = await vault.read.idleAssets([token.address]);
      const sA = await vault.read.strategyAssets([token.address, stratA.address]);
      const sB = await vault.read.strategyAssets([token.address, stratB.address]);
      const total = await vault.read.totalAssets([token.address]);
      assert.equal(total, idle + sA + sB);
    }
  });
});
