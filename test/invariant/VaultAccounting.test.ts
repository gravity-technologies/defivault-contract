import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("GRVTL1TreasuryVault accounting invariant", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, l2Recipient, other] = wallets;

  const L2_GAS_LIMIT = 900_000n;
  const L2_GAS_PER_PUBDATA = 800n;

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

  async function deployVault() {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const baseToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const vaultImpl = await viem.deployContract("GRVTL1TreasuryVault");
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [
        addr(admin),
        bridge.address,
        baseToken.address,
        270n,
        addr(l2Recipient),
        wrappedNative.address,
        addr(other),
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      vaultImpl.address,
      addr(admin),
      initData,
    ]);
    const vault = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      proxy.address,
    );

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.grantRole([
      await vault.read.REBALANCER_ROLE(),
      addr(rebalancer),
    ]);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
    );
    const vaultAsRebalancer = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: rebalancer },
      },
    );

    return { vault, vaultAsAllocator, vaultAsRebalancer };
  }

  function componentTotal(breakdown: {
    components: ReadonlyArray<{ amount: bigint }>;
  }): bigint {
    return breakdown.components.reduce(
      (sum, component) => sum + component.amount,
      0n,
    );
  }

  it("keeps totalAssets consistent with idle + strategies across random sequences", async function () {
    const { vault, vaultAsAllocator, vaultAsRebalancer } = await deployVault();

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 3_000_000n]);

    const stratA = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "STRAT_A",
    ]);
    const stratB = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "STRAT_B",
    ]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: true, active: false, cap: 2_000_000n },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratB.address,
      { whitelisted: true, active: false, cap: 2_000_000n },
    ]);

    const rng = mulberry32(42);
    const strategies = [stratA.address, stratB.address];

    for (let i = 0; i < 30; i++) {
      const action = Math.floor(rng() * 3);

      if (action === 0) {
        const idle = (await vault.read.idleTokenBalance([
          token.address,
        ])) as bigint;
        const strategy = strategies[Math.floor(rng() * strategies.length)];
        const current = componentTotal(
          await vault.read.strategyAssetBreakdown([token.address, strategy]),
        );
        const remainingCap = 2_000_000n > current ? 2_000_000n - current : 0n;
        let amount = idle / 10n;
        if (amount > remainingCap) amount = remainingCap;
        if (amount > 0n) {
          await vaultAsAllocator.write.allocatePrincipalToStrategy([
            token.address,
            strategy,
            amount,
          ]);
        }
      } else if (action === 1) {
        const strategy = strategies[Math.floor(rng() * strategies.length)];
        const sAssets = componentTotal(
          await vault.read.strategyAssetBreakdown([token.address, strategy]),
        );
        const amount = sAssets / 2n;
        if (amount > 0n) {
          await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
            token.address,
            strategy,
            amount,
          ]);
        }
      } else {
        const available = (await vault.read.availableErc20ForRebalance([
          token.address,
        ])) as bigint;
        let amount = available / 5n;
        if (amount > 500_000n) amount = 500_000n;
        if (amount > 0n) {
          await vaultAsRebalancer.write.rebalanceErc20ToL2([
            token.address,
            amount,
          ]);
        }
      }

      const idle = (await vault.read.idleTokenBalance([
        token.address,
      ])) as bigint;
      const sA = componentTotal(
        await vault.read.strategyAssetBreakdown([
          token.address,
          stratA.address,
        ]),
      );
      const sB = componentTotal(
        await vault.read.strategyAssetBreakdown([
          token.address,
          stratB.address,
        ]),
      );
      const totals = await vault.read.totalExactAssets([token.address]);
      const status = await vault.read.totalExactAssetsStatus([token.address]);

      assert.equal(status.skippedStrategies, 0n);
      assert.equal(totals.total, idle + sA + sB);
      assert.equal(status.total, totals.total);
    }
  });

  it("keeps totalAssetsStatus callable in degraded mode with reverting strategies", async function () {
    const { vault, vaultAsAllocator } = await deployVault();

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 1_500_000n]);

    const healthy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "HEALTHY",
    ]);
    const reverting = await viem.deployContract("MockRevertingStrategy");

    await vault.write.setPrincipalTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      healthy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      reverting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      healthy.address,
      400_000n,
    ]);

    const status = await vault.read.totalExactAssetsStatus([token.address]);
    const idle = await vault.read.idleTokenBalance([token.address]);
    const healthyAssets = componentTotal(
      await vault.read.strategyAssetBreakdown([token.address, healthy.address]),
    );

    assert.ok(status.skippedStrategies > 0n);
    assert.equal(status.total, idle + healthyAssets);
  });
});
