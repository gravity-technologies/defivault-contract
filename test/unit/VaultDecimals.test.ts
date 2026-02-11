import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("GRVTDeFiVault decimals coverage", async function () {
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

  for (const decimals of [6, 8, 18] as const) {
    it(`handles allocate/deallocate/rebalance/emergency with ${decimals}-decimals token`, async function () {
      const unit = 10n ** BigInt(decimals);

      const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
      const baseToken = await viem.deployContract("MockERC20", [
        "Mock Base",
        "mBASE",
        18,
      ]);
      const vaultImpl = await viem.deployContract("GRVTDeFiVault");
      const initData = encodeFunctionData({
        abi: vaultImpl.abi,
        functionName: "initialize",
        args: [
          addr(admin),
          bridge.address,
          baseToken.address,
          270n,
          addr(l2Recipient),
        ],
      });
      const proxy = await viem.deployContract(
        "TestTransparentUpgradeableProxy",
        [vaultImpl.address, addr(admin), initData],
      );
      const vault = await viem.getContractAt("GRVTDeFiVault", proxy.address);

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

      await vault.write.setTokenConfig([
        token.address,
        {
          supported: true,
        },
      ]);

      const strategy = await viem.deployContract("MockYieldStrategy", [
        vault.address,
        `STRAT_${decimals}`,
      ]);
      await vault.write.whitelistStrategy([
        token.address,
        strategy.address,
        { whitelisted: true, active: false, cap: 900_000n * unit },
      ]);

      const vaultAsAllocator = await viem.getContractAt(
        "GRVTDeFiVault",
        vault.address,
        {
          client: { public: publicClient, wallet: allocator },
        },
      );
      const vaultAsRebalancer = await viem.getContractAt(
        "GRVTDeFiVault",
        vault.address,
        {
          client: { public: publicClient, wallet: rebalancer },
        },
      );

      await vaultAsAllocator.write.allocateToStrategy([
        token.address,
        strategy.address,
        400_000n * unit,
      ]);
      await vaultAsAllocator.write.deallocateFromStrategy([
        token.address,
        strategy.address,
        150_000n * unit,
      ]);
      await vaultAsRebalancer.write.rebalanceToL2([
        token.address,
        200_000n * unit,
      ]);
      await vaultAsRebalancer.write.emergencySendToL2([
        token.address,
        50_000n * unit,
      ]);

      assert.equal(await bridge.read.lastAmount(), 50_000n * unit);

      const idle = (await vault.read.idleAssets([token.address])) as bigint;
      const strategyAssets = (await vault.read.strategyAssets([
        token.address,
        strategy.address,
      ])) as bigint;
      const total = (await vault.read.totalAssets([token.address])) as bigint;
      const [statusTotal, skipped] = (await vault.read.totalAssetsStatus([
        token.address,
      ])) as [bigint, bigint];

      assert.equal(skipped, 0n);
      assert.equal(total, idle + strategyAssets);
      assert.equal(statusTotal, total);
      assert.equal(strategyAssets, 250_000n * unit);
    });
  }
});
