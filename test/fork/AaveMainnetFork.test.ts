import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, parseAbi } from "viem";

import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const FORK_BLOCK = 22_000_000;

const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3f4ce8392D69350B4fA4E2" as const;
const AUSDT = "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a" as const;
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC" as const;

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const describeFork = MAINNET_RPC_URL ? describe : describe.skip;

describeFork("Aave v3 mainnet fork integration", async function () {
  const { viem } = await network.connect({
    network: "hardhatMainnet",
    chainType: "l1",
    override: {
      forking: {
        enabled: true,
        url: MAINNET_RPC_URL!,
        blockNumber: FORK_BLOCK,
      },
    },
  });

  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const wallets = await viem.getWalletClients();
  const [
    admin,
    vaultWallet,
    allocatorWallet,
    rebalancerWallet,
    l2RecipientWallet,
    otherWallet,
  ] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  function componentTotal(
    components: ReadonlyArray<{ amount: bigint }>,
  ): bigint {
    return components.reduce((sum, component) => sum + component.amount, 0n);
  }

  async function usdtBalanceOf(account: `0x${string}`) {
    return publicClient.readContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async function transferUsdtFromWhale(to: `0x${string}`, amount: bigint) {
    await testClient.setBalance({ address: USDT_WHALE, value: 10n ** 19n });
    await testClient.impersonateAccount({ address: USDT_WHALE });

    try {
      const transferData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
      });

      const txHash = (await publicClient.request({
        method: "eth_sendTransaction" as any,
        params: [{ from: USDT_WHALE, to: USDT, data: transferData }],
      } as any)) as `0x${string}`;
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    } finally {
      await testClient.stopImpersonatingAccount({ address: USDT_WHALE });
    }
  }

  async function deployAaveUsdtStrategy(vaultAddress: `0x${string}`) {
    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const initData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [vaultAddress, AAVE_V3_POOL, USDT, AUSDT, "AAVE_V3_USDT_FORK"],
    });

    const strategyProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [strategyImpl.address, addr(admin), initData],
    );

    return viem.getContractAt("AaveV3Strategy", strategyProxy.address);
  }

  it("AaveV3Strategy allocates and deallocates real USDT through real Aave pool", async function () {
    const amount = 100_000_000n; // 100 USDT
    const strategy = await deployAaveUsdtStrategy(addr(vaultWallet));

    await transferUsdtFromWhale(addr(vaultWallet), amount);

    const beforeVault = await usdtBalanceOf(addr(vaultWallet));
    await vaultWallet.writeContract({
      address: USDT,
      abi: erc20Abi,
      functionName: "approve",
      args: [strategy.address, amount],
    });

    const strategyAsVault = await viem.getContractAt(
      "AaveV3Strategy",
      strategy.address,
      {
        client: { public: publicClient, wallet: vaultWallet },
      },
    );

    await strategyAsVault.write.allocate([USDT, amount]);

    const afterAllocateVault = await usdtBalanceOf(addr(vaultWallet));
    assert.equal(beforeVault - afterAllocateVault, amount);

    const strategyATokenAfterAllocate = await strategy.read.exactTokenBalance([
      AUSDT,
    ]);
    assert.ok(strategyATokenAfterAllocate >= amount - 1n);

    const beforeHalfWithdrawVault = await usdtBalanceOf(addr(vaultWallet));
    await strategyAsVault.write.deallocate([USDT, amount / 2n]);
    const afterHalfWithdrawVault = await usdtBalanceOf(addr(vaultWallet));

    assert.ok(afterHalfWithdrawVault > beforeHalfWithdrawVault);
    assert.ok(
      afterHalfWithdrawVault - beforeHalfWithdrawVault >= amount / 2n - 2n,
    );

    await strategyAsVault.write.deallocateAll([USDT]);

    const strategyATokenAfterAll = await strategy.read.exactTokenBalance([
      AUSDT,
    ]);
    assert.ok(strategyATokenAfterAll <= 2n);

    const finalVault = await usdtBalanceOf(addr(vaultWallet));
    assert.ok(finalVault >= beforeVault - 2n);
  });

  it("vault + Aave strategy on fork preserves defensive exit semantics", async function () {
    const bridge = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
    const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
      "Mock Base",
      "mBASE",
      18,
    ]);
    const wrappedNative = await viem.deployContract("MockWETH");
    const { vaultImplementation: vaultImpl } =
      await deployVaultImplementation(viem);
    const initData = encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [
        addr(admin),
        bridge.address,
        grvtBridgeProxyFeeToken.address,
        270n,
        addr(l2RecipientWallet),
        wrappedNative.address,
        addr(otherWallet),
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

    const strategy = await deployAaveUsdtStrategy(vault.address);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocatorWallet),
    ]);
    await vault.write.grantRole([
      await vault.read.REBALANCER_ROLE(),
      addr(rebalancerWallet),
    ]);

    await vault.write.setVaultTokenConfig([
      USDT,
      {
        supported: true,
      },
    ]);
    await vault.write.setBridgeableVaultToken([USDT, true]);

    await vault.write.setVaultTokenStrategyConfig([
      USDT,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    const fundAmount = 80_000_000n; // 80 USDT
    await transferUsdtFromWhale(vault.address, fundAmount);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocatorWallet },
      },
    );

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      USDT,
      strategy.address,
      50_000_000n,
    ]);

    await vault.write.pause();
    await vault.write.setVaultTokenConfig([
      USDT,
      {
        supported: false,
      },
    ]);

    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      USDT,
      strategy.address,
    ]);

    const strategyAssets = componentTotal(
      await vault.read.strategyPositionBreakdown([USDT, strategy.address]),
    );
    assert.ok(strategyAssets <= 2n);

    const status = await vault.read.tokenTotalsConservative([USDT]);
    assert.equal(status.skippedStrategies, 0n);
    assert.ok(status.total > 0n);

    const vaultAsRebalancer = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: rebalancerWallet },
      },
    );
    await vaultAsRebalancer.write.emergencyErc20ToL2([USDT, 10_000_000n]);
    assert.equal(await bridge.read.lastAmount(), 10_000_000n);
  });
});
