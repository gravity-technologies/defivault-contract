import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const MAINNET_FORK_BLOCK = process.env.MAINNET_FORK_BLOCK
  ? Number(process.env.MAINNET_FORK_BLOCK)
  : 22_000_000;

const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3f4ce8392D69350B4fA4E2" as const;
const AUSDT = "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a" as const;
const USDT_WHALE = "0xF977814e90dA44bFA03b6295A0616a897441aceC" as const;

const describeFork = MAINNET_RPC_URL ? describe : describe.skip;

describeFork("Aave v3 mainnet fork integration", async function () {
  const { viem } = await network.connect({
    network: "hardhatMainnet",
    chainType: "l1",
    override: {
      forking: {
        enabled: true,
        url: MAINNET_RPC_URL!,
        blockNumber: MAINNET_FORK_BLOCK,
      },
    },
  });
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const wallets = await viem.getWalletClients();
  const [admin, vaultWallet] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  it("supplies and withdraws USDT through AaveV3Strategy", async function () {
    const amount = 10_000_000n; // 10 USDT

    const strategyImpl = await viem.deployContract("AaveV3Strategy");
    const initData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [addr(vaultWallet), AAVE_V3_POOL, USDT, AUSDT, "AAVE_V3_USDT_FORK"],
    });
    const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      strategyImpl.address,
      addr(admin),
      initData,
    ]);
    const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy.address);

    await testClient.setBalance({ address: USDT_WHALE, value: 10n ** 19n });
    await testClient.impersonateAccount({ address: USDT_WHALE });

    const transferData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "transfer",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "transfer",
      args: [addr(vaultWallet), amount],
    });

    const txHash = await publicClient.request({
      method: "eth_sendTransaction",
      params: [{ from: USDT_WHALE, to: USDT, data: transferData }],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const usdtAsVault = await viem.getContractAt("MockERC20", USDT, {
      client: { public: publicClient, wallet: vaultWallet },
    });
    await usdtAsVault.write.approve([strategy.address, amount]);

    const strategyAsVault = await viem.getContractAt("AaveV3Strategy", strategy.address, {
      client: { public: publicClient, wallet: vaultWallet },
    });

    await strategyAsVault.write.allocate([USDT, amount, "0x"]);
    assert.equal(await strategy.read.assets([USDT]), amount);

    await strategyAsVault.write.deallocate([USDT, amount / 2n, "0x"]);
    assert.ok((await strategy.read.assets([USDT])) <= amount / 2n);

    await strategyAsVault.write.deallocateAll([USDT, "0x"]);
    assert.equal(await strategy.read.assets([USDT]), 0n);

    await testClient.stopImpersonatingAccount({ address: USDT_WHALE });
  });
});
