import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("GRVTL1TreasuryVault decimals coverage", async function () {
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

  for (const decimals of [6, 8, 18] as const) {
    it(`handles allocate/deallocate/rebalance/emergency with ${decimals}-decimals token`, async function () {
      const unit = 10n ** BigInt(decimals);

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
          addr(l2Recipient),
        ],
      });
      const proxy = await viem.deployContract(
        "TestTransparentUpgradeableProxy",
        [vaultImpl.address, addr(admin), initData],
      );
      const vault = await viem.getContractAt(
        "GRVTL1TreasuryVault",
        proxy.address,
      );

      const token = await viem.deployContract("MockERC20", [
        `Mock ${decimals}d`,
        `M${decimals}`,
        decimals,
      ]);
      await token.write.mint([vault.address, 2_000_000n * unit]);

      await vault.write.grantRole([
        await vault.read.ALLOCATOR_ROLE(),
        addr(allocator),
      ]);
      await vault.write.grantRole([
        await vault.read.REBALANCER_ROLE(),
        addr(rebalancer),
      ]);

      await vault.write.setPrincipalTokenConfig([
        token.address,
        {
          supported: true,
        },
      ]);

      const strategy = await viem.deployContract("MockYieldStrategy", [
        vault.address,
        `STRAT_${decimals}`,
      ]);
      await vault.write.setPrincipalStrategyWhitelist([
        token.address,
        strategy.address,
        { whitelisted: true, active: false, cap: 900_000n * unit },
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

      await vaultAsAllocator.write.allocatePrincipalToStrategy([
        token.address,
        strategy.address,
        400_000n * unit,
      ]);
      await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
        token.address,
        strategy.address,
        150_000n * unit,
      ]);
      await vaultAsRebalancer.write.rebalanceErc20ToL2([
        token.address,
        200_000n * unit,
      ]);
      await vaultAsRebalancer.write.emergencyErc20ToL2([
        token.address,
        50_000n * unit,
      ]);

      assert.equal(await bridge.read.lastAmount(), 50_000n * unit);

      const idle = (await vault.read.idleTokenBalance([
        token.address,
      ])) as bigint;
      const breakdown = await vault.read.strategyAssetBreakdown([
        token.address,
        strategy.address,
      ]);
      const strategyAssets = breakdown.components.reduce(
        (sum, component) => sum + component.amount,
        0n,
      );
      const totals = await vault.read.totalExactAssets([token.address]);
      const status = await vault.read.totalExactAssetsStatus([token.address]);

      assert.equal(status.skippedStrategies, 0n);
      assert.equal(totals.total, idle + strategyAssets);
      assert.equal(status.total, totals.total);
      assert.equal(strategyAssets, 250_000n * unit);
    });
  }
});
