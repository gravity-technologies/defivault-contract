import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroHash } from "viem";

describe("GRVTDeFiVault", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  async function deployBase() {
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
    await token.write.mint([vault.address, 2_000_000n]);

    const allocatorRole = await vault.read.ALLOCATOR_ROLE();
    const rebalancerRole = await vault.read.REBALANCER_ROLE();
    const pauserRole = await vault.read.PAUSER_ROLE();

    await vault.write.grantRole([allocatorRole, addr(allocator)]);
    await vault.write.grantRole([rebalancerRole, addr(rebalancer)]);
    await vault.write.grantRole([pauserRole, addr(pauser)]);

    await vault.write.setTokenConfig([
      token.address,
      {
        supported: true,
        idleReserve: 100_000n,
        rebalanceMaxPerTx: 500_000n,
        rebalanceMinDelay: 60n,
      },
    ]);

    const stratA = await viem.deployContract("MockYieldStrategy", [vault.address, "STRAT_A"]);
    const stratB = await viem.deployContract("MockYieldStrategy", [vault.address, "STRAT_B"]);
    await vault.write.whitelistStrategy([
      token.address,
      stratA.address,
      { whitelisted: true, cap: 800_000n, tag: zeroHash },
    ]);
    await vault.write.whitelistStrategy([
      token.address,
      stratB.address,
      { whitelisted: true, cap: 800_000n, tag: zeroHash },
    ]);

    const vaultAsAllocator = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: allocator },
    });
    const vaultAsRebalancer = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: rebalancer },
    });
    const vaultAsPauser = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: pauser },
    });
    const vaultAsOther = await viem.getContractAt("GRVTDeFiVault", vault.address, {
      client: { public: publicClient, wallet: other },
    });

    return {
      bridge,
      vault,
      token,
      stratA,
      stratB,
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      vaultAsOther,
    };
  }

  it("enforces RBAC and pause controls", async function () {
    const { vaultAsOther, vaultAsPauser, vault } = await deployBase();

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.pause(),
      vaultAsOther,
      "Unauthorized",
    );

    await vaultAsPauser.write.pause();
    assert.equal(await vault.read.paused(), true);
    await vaultAsPauser.write.unpause();
    assert.equal(await vault.read.paused(), false);
  });

  it("allocates/deallocates with reserve and strategy caps", async function () {
    const { vaultAsAllocator, vault, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratA.address,
      500_000n,
      "0x",
    ]);
    assert.equal(await vault.read.strategyAssets([token.address, stratA.address]), 500_000n);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([
        token.address,
        stratA.address,
        400_000n,
        "0x",
      ]),
      vaultAsAllocator,
      "CapExceeded",
    );

    await vaultAsAllocator.write.deallocateFromStrategy([
      token.address,
      stratA.address,
      200_000n,
      "0x",
    ]);
    assert.equal(await vault.read.strategyAssets([token.address, stratA.address]), 300_000n);
  });

  it("enforces rebalance max and min-delay", async function () {
    const { vaultAsRebalancer, vault, token } = await deployBase();

    await vaultAsRebalancer.write.rebalanceToL2([token.address, 300_000n, "0x1234"]);
    const firstTs = await vault.read.lastRebalanceAt([token.address]);
    assert.notEqual(firstTs, 0n);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([token.address, 100_000n, "0xab"]),
      vaultAsRebalancer,
      "RateLimited",
    );

    await testClient.increaseTime({ seconds: 61 });
    await testClient.mine({ blocks: 1 });

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([token.address, 700_000n, "0x"]),
      vaultAsRebalancer,
      "CapExceeded",
    );
  });

  it("emergency bypasses rebalance cap and min-delay while paused", async function () {
    const { vaultAsRebalancer, vaultAsPauser, token, bridge } = await deployBase();

    await vaultAsRebalancer.write.rebalanceToL2([token.address, 300_000n, "0x1111"]);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([token.address, 100_000n, "0x2222"]),
      vaultAsRebalancer,
      "RateLimited",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceToL2([token.address, 700_000n, "0x3333"]),
      vaultAsRebalancer,
      "CapExceeded",
    );

    await vaultAsPauser.write.pause();
    await vaultAsRebalancer.write.emergencySendToL2([token.address, 700_000n, "0x4444"]);

    assert.equal((await bridge.read.lastToken()).toLowerCase(), token.address.toLowerCase());
    assert.equal(await bridge.read.lastAmount(), 700_000n);
  });

  it("emergency send works while paused and pulls from strategies", async function () {
    const { vaultAsAllocator, vaultAsRebalancer, vault, token, stratA, stratB, bridge, vaultAsPauser } =
      await deployBase();

    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratA.address,
      700_000n,
      "0x",
    ]);
    await vaultAsAllocator.write.allocateToStrategy([
      token.address,
      stratB.address,
      500_000n,
      "0x",
    ]);

    await vaultAsPauser.write.pause();

    await vaultAsRebalancer.write.emergencySendToL2([token.address, 1_000_000n, "0xbeef"]);

    assert.equal((await bridge.read.lastToken()).toLowerCase(), token.address.toLowerCase());
    assert.equal(await bridge.read.lastAmount(), 1_000_000n);
    assert.equal(
      (await bridge.read.lastRecipient()).toLowerCase(),
      addr(l2Recipient).toLowerCase(),
    );
  });

  it("rejects unsupported and unwhitelisted strategy actions", async function () {
    const { vault, token, vaultAsAllocator } = await deployBase();
    const rogueStrat = await viem.deployContract("MockYieldStrategy", [vault.address, "ROGUE"]);
    const unsupported = await viem.deployContract("MockERC20", ["Unsupported", "UNS", 6]);
    await unsupported.write.mint([vault.address, 1_000_000n]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([
        token.address,
        rogueStrat.address,
        100_000n,
        "0x",
      ]),
      vaultAsAllocator,
      "StrategyNotWhitelisted",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocateToStrategy([
        unsupported.address,
        rogueStrat.address,
        100_000n,
        "0x",
      ]),
      vaultAsAllocator,
      "TokenNotSupported",
    );
  });
});
