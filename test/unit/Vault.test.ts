import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { expectEventOnce } from "../helpers/events.js";

describe("GRVTL1TreasuryVault core flows", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const [admin, allocator, rebalancer, pauser, l2Recipient, other] = wallets;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) throw new Error("wallet has no account");
    return wallet.account.address;
  }

  function componentTotal(breakdown: {
    components: ReadonlyArray<{ amount: bigint }>;
  }): bigint {
    return breakdown.components.reduce(
      (sum, component) => sum + component.amount,
      0n,
    );
  }

  async function deployBase() {
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

    const token = await viem.deployContract("MockERC20", [
      "Mock USDT",
      "mUSDT",
      6,
    ]);
    await token.write.mint([vault.address, 2_000_000n]);

    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.grantRole([
      await vault.read.REBALANCER_ROLE(),
      addr(rebalancer),
    ]);
    await vault.write.grantRole([await vault.read.PAUSER_ROLE(), addr(pauser)]);

    await vault.write.setPrincipalTokenConfig([
      token.address,
      { supported: true },
    ]);

    const stratA = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "STRAT_A",
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: true, active: false, cap: 2_000_000n },
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
    const vaultAsPauser = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: pauser },
      },
    );
    const vaultAsAdmin = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: admin },
      },
    );
    const vaultAsOther = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: other },
      },
    );

    return {
      bridge,
      baseToken,
      vault,
      token,
      stratA,
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      vaultAsAdmin,
      vaultAsOther,
    };
  }

  it("enforces RBAC on pause controls", async function () {
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

  it("enforces pause and unpause state transition guards", async function () {
    const { vaultAsOther, vaultAsPauser } = await deployBase();

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.unpause(),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsPauser.write.unpause(),
      vaultAsPauser,
      "InvalidParam",
    );

    await vaultAsPauser.write.pause();
    await viem.assertions.revertWithCustomError(
      vaultAsPauser.write.pause(),
      vaultAsPauser,
      "InvalidParam",
    );

    await vaultAsPauser.write.unpause();
    await viem.assertions.revertWithCustomError(
      vaultAsPauser.write.unpause(),
      vaultAsPauser,
      "InvalidParam",
    );
  });

  it("blocks risk-on ops when paused but allows defensive exits", async function () {
    const {
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsPauser,
      token,
      stratA,
      bridge,
    } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      500_000n,
    ]);
    await vaultAsPauser.write.pause();

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocatePrincipalToStrategy([
        token.address,
        stratA.address,
        1n,
      ]),
      vaultAsAllocator,
      "Paused",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n]),
      vaultAsRebalancer,
      "Paused",
    );

    await vaultAsAllocator.write.deallocatePrincipalFromStrategy([
      token.address,
      stratA.address,
      100_000n,
    ]);
    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 200_000n]);
    assert.equal(await bridge.read.lastAmount(), 200_000n);
  });

  it("uses supported flag only for risk-on paths", async function () {
    const {
      vault,
      vaultAsAllocator,
      vaultAsRebalancer,
      vaultAsAdmin,
      token,
      stratA,
      bridge,
    } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      600_000n,
    ]);
    await vault.write.setPrincipalTokenConfig([
      token.address,
      { supported: false },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocatePrincipalToStrategy([
        token.address,
        stratA.address,
        1n,
      ]),
      vaultAsAllocator,
      "TokenNotSupported",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n]),
      vaultAsRebalancer,
      "TokenNotSupported",
    );

    await vaultAsAdmin.write.deallocateAllPrincipalFromStrategy([
      token.address,
      stratA.address,
    ]);
    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 100_000n]);
    assert.equal(await bridge.read.lastAmount(), 100_000n);
  });

  it("allows VAULT_ADMIN fallback for deallocation", async function () {
    const {
      vaultAsAllocator,
      vaultAsAdmin,
      vaultAsOther,
      vault,
      token,
      stratA,
    } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      400_000n,
    ]);
    await vaultAsAdmin.write.deallocatePrincipalFromStrategy([
      token.address,
      stratA.address,
      150_000n,
    ]);
    assert.equal(
      componentTotal(
        await vault.read.strategyAssetBreakdown([
          token.address,
          stratA.address,
        ]),
      ),
      250_000n,
    );

    await vaultAsAdmin.write.deallocateAllPrincipalFromStrategy([
      token.address,
      stratA.address,
    ]);
    assert.equal(
      componentTotal(
        await vault.read.strategyAssetBreakdown([
          token.address,
          stratA.address,
        ]),
      ),
      0n,
    );

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.deallocatePrincipalFromStrategy([
        token.address,
        stratA.address,
        1n,
      ]),
      vaultAsOther,
      "Unauthorized",
    );
  });

  it("keeps de-whitelisted strategies in withdraw-only mode until empty", async function () {
    const { vault, vaultAsAllocator, token, stratA } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      300_000n,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsAllocator.write.allocatePrincipalToStrategy([
        token.address,
        stratA.address,
        1n,
      ]),
      vaultAsAllocator,
      "StrategyNotWhitelisted",
    );

    await vaultAsAllocator.write.deallocateAllPrincipalFromStrategy([
      token.address,
      stratA.address,
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);

    const list = (await vault.read.getPrincipalTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(
      list
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(stratA.address.toLowerCase()),
      false,
    );
  });

  it("keeps strategy withdraw-only when de-listing assets probe reverts", async function () {
    const { vault, token } = await deployBase();
    const reverting = await viem.deployContract("MockRevertingStrategy");

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      reverting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    const hash = await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      reverting.address,
      { whitelisted: false, active: false, cap: 0n },
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const removalCheck = expectEventOnce(
      receipt,
      vault,
      "StrategyRemovalCheckFailed",
    );
    assert.equal(
      (removalCheck.token as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (removalCheck.strategy as string).toLowerCase(),
      reverting.address.toLowerCase(),
    );

    const cfg = (await vault.read.getPrincipalStrategyConfig([
      token.address,
      reverting.address,
    ])) as { whitelisted: boolean; active: boolean; cap: bigint };
    assert.equal(cfg.whitelisted, false);
    assert.equal(cfg.active, true);

    const list = (await vault.read.getPrincipalTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(
      list
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(reverting.address.toLowerCase()),
      true,
    );
  });

  it("validates whitelistStrategy auth and input constraints", async function () {
    const { vault, vaultAsOther, token } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    const strategy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "NEW_STRAT",
    ]);
    const unsupportedToken = await viem.deployContract("MockERC20", [
      "Unsupported",
      "UNSUP",
      6,
    ]);

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setPrincipalStrategyWhitelist([
        token.address,
        strategy.address,
        { whitelisted: true, active: false, cap: 0n },
      ]),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vault.write.setPrincipalStrategyWhitelist([
        zeroAddress,
        strategy.address,
        { whitelisted: true, active: false, cap: 0n },
      ]),
      vault,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vault.write.setPrincipalStrategyWhitelist([
        token.address,
        zeroAddress,
        { whitelisted: true, active: false, cap: 0n },
      ]),
      vault,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vault.write.setPrincipalStrategyWhitelist([
        unsupportedToken.address,
        strategy.address,
        { whitelisted: true, active: false, cap: 0n },
      ]),
      vault,
      "TokenNotSupported",
    );
  });

  it("enforces strategy-set bounds and avoids duplicate membership entries", async function () {
    const { vault, token, stratA } = await deployBase();

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      stratA.address,
      { whitelisted: true, active: false, cap: 1_111_111n },
    ]);
    let list = (await vault.read.getPrincipalTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(list.length, 1);
    assert.equal(
      (
        (await vault.read.getPrincipalStrategyConfig([
          token.address,
          stratA.address,
        ])) as { whitelisted: boolean; active: boolean; cap: bigint }
      ).cap,
      1_111_111n,
    );

    const extraStrategies = [];
    for (let i = 0; i < 7; i++) {
      const strategy = await viem.deployContract("MockYieldStrategy", [
        vault.address,
        `EXTRA_${i}`,
      ]);
      extraStrategies.push(strategy);
      await vault.write.setPrincipalStrategyWhitelist([
        token.address,
        strategy.address,
        { whitelisted: true, active: false, cap: 0n },
      ]);
    }
    list = (await vault.read.getPrincipalTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(list.length, 8);

    const ninth = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "EXTRA_8",
    ]);
    await viem.assertions.revertWithCustomError(
      vault.write.setPrincipalStrategyWhitelist([
        token.address,
        ninth.address,
        { whitelisted: true, active: false, cap: 0n },
      ]),
      vault,
      "CapExceeded",
    );

    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      extraStrategies[0].address,
      { whitelisted: false, active: false, cap: 0n },
    ]);
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      ninth.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    list = (await vault.read.getPrincipalTokenStrategies([
      token.address,
    ])) as Array<`0x${string}`>;
    assert.equal(list.length, 8);
    assert.equal(
      list
        .map((a: `0x${string}`) => a.toLowerCase())
        .includes(ninth.address.toLowerCase()),
      true,
    );
  });

  it("keeps totalAssetsStatus callable when one strategy reverts", async function () {
    const { vault, vaultAsAllocator, token } = await deployBase();
    const healthy = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "HEALTHY",
    ]);
    const reverting = await viem.deployContract("MockRevertingStrategy");

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
      200_000n,
    ]);

    const status = await vault.read.totalExactAssetsStatus([token.address]);
    const idle = await vault.read.idleTokenBalance([token.address]);
    const healthyAssets = componentTotal(
      await vault.read.strategyAssetBreakdown([token.address, healthy.address]),
    );
    assert.ok(status.skippedStrategies > 0n);
    assert.equal(status.total, idle + healthyAssets);
  });

  it("returns 0 for inactive strategyAssets and bubbles revert for active reverting strategies", async function () {
    const { vault, token } = await deployBase();
    const inactive = await viem.deployContract("MockYieldStrategy", [
      vault.address,
      "INACTIVE",
    ]);
    const inactiveBreakdown = await vault.read.strategyAssetBreakdown([
      token.address,
      inactive.address,
    ]);
    assert.equal(inactiveBreakdown.components.length, 0);

    const reverting = await viem.deployContract("MockRevertingStrategy");
    await vault.write.setPrincipalStrategyWhitelist([
      token.address,
      reverting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await assert.rejects(
      vault.read.strategyAssetBreakdown([token.address, reverting.address]),
    );
  });

  it("sweepNative is admin-only and bounded", async function () {
    const { vault, vaultAsAdmin, vaultAsOther } = await deployBase();

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.sweepNativeToYieldRecipient([1n]),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsAdmin.write.sweepNativeToYieldRecipient([1n]),
      vaultAsAdmin,
      "InvalidParam",
    );
  });

  it("validates setTokenConfig auth and token address", async function () {
    const { vault, vaultAsOther } = await deployBase();
    const token = await viem.deployContract("MockERC20", ["Other", "OTH", 6]);

    await viem.assertions.revertWithCustomError(
      vaultAsOther.write.setPrincipalTokenConfig([
        token.address,
        { supported: true },
      ]),
      vaultAsOther,
      "Unauthorized",
    );
    await viem.assertions.revertWithCustomError(
      vault.write.setPrincipalTokenConfig([addr(other), { supported: true }]),
      vault,
      "InvalidParam",
    );
  });

  it("keeps bridge config initialized and non-zero", async function () {
    const { vault, bridge, baseToken } = await deployBase();

    assert.equal(
      ((await vault.read.bridgeHub()) as `0x${string}`).toLowerCase(),
      bridge.address.toLowerCase(),
    );
    assert.equal(
      ((await vault.read.baseToken()) as `0x${string}`).toLowerCase(),
      baseToken.address.toLowerCase(),
    );
    assert.equal(await vault.read.l2ChainId(), 270n);
  });

  it("validates rebalance and emergency input constraints", async function () {
    const { vaultAsRebalancer, token } = await deployBase();
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([zeroAddress, 10n]),
      vaultAsRebalancer,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 0n]),
      vaultAsRebalancer,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.emergencyErc20ToL2([zeroAddress, 10n]),
      vaultAsRebalancer,
      "InvalidParam",
    );
    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 0n]),
      vaultAsRebalancer,
      "InvalidParam",
    );
  });

  it("rebalances with zero ETH and enforces available amount", async function () {
    const { vaultAsRebalancer, token, bridge } = await deployBase();

    await vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n]);
    assert.equal(await bridge.read.lastAmount(), 100_000n);

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 100_000n], {
        value: 1n,
      }),
      vaultAsRebalancer,
      "InvalidParam",
    );

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.rebalanceErc20ToL2([token.address, 10_000_000n]),
      vaultAsRebalancer,
      "InvalidParam",
    );
  });

  it("reverts emergency send when msg.value is non-zero", async function () {
    const { vaultAsRebalancer, token } = await deployBase();

    await viem.assertions.revertWithCustomError(
      vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 100_000n], {
        value: 1n,
      }),
      vaultAsRebalancer,
      "InvalidParam",
    );
  });

  it("emergency send can unwind from strategy when idle is insufficient", async function () {
    const {
      vault,
      vaultAsAllocator,
      vaultAsRebalancer,
      token,
      stratA,
      bridge,
    } = await deployBase();

    await vaultAsAllocator.write.allocatePrincipalToStrategy([
      token.address,
      stratA.address,
      1_700_000n,
    ]);
    await vaultAsRebalancer.write.emergencyErc20ToL2([token.address, 500_000n]);

    assert.equal(await bridge.read.lastAmount(), 500_000n);
    assert.ok(
      componentTotal(
        await vault.read.strategyAssetBreakdown([
          token.address,
          stratA.address,
        ]),
      ) < 1_700_000n,
    );
  });
});
