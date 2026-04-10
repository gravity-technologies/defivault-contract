import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { deployVaultImplementation } from "../helpers/vaultDeployment.js";

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

  async function deployPolicyVault() {
    const treasury = await viem.deployContract("MockWithdrawalFeeTreasury");
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
        addr(l2Recipient),
        wrappedNative.address,
        treasury.address,
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
    await treasury.write.setAuthorizedVault([vault.address, true]);

    const vaultToken = await viem.deployContract("MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    const gho = await viem.deployContract("MockERC20", ["GHO", "GHO", 18]);
    const stkGho = await viem.deployContract("MockStkGho", [gho.address]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      vaultToken.address,
    ] as any);
    const staking = stkGho;
    const rewardsDistributor = await viem.deployContract(
      "MockAngleRewardsDistributor",
      [stkGho.address],
    );
    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);

    const strategyImpl = await viem.deployContract("GsmStkGhoStrategy");
    const strategyInitData = encodeFunctionData({
      abi: strategyImpl.abi,
      functionName: "initialize",
      args: [
        vault.address,
        stkGho.address,
        gsm.address,
        rewardsDistributor.address,
        "GSM_STKGHO_USDC",
      ],
    });
    const strategyProxy = await viem.deployContract(
      "TestTransparentUpgradeableProxy",
      [strategyImpl.address, addr(admin), strategyInitData],
    );
    const strategy = await viem.getContractAt(
      "GsmStkGhoStrategy",
      strategyProxy.address,
    );

    await vaultToken.write.mint([vault.address, 200_000n]);
    await vaultToken.write.mint([treasury.address, 100_000n]);
    await vault.write.grantRole([
      await vault.read.ALLOCATOR_ROLE(),
      addr(allocator),
    ]);
    await vault.write.setVaultTokenConfig([
      vaultToken.address,
      { supported: true },
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      vaultToken.address,
      strategy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await treasury.write.setReimbursementConfig([
      strategy.address,
      vaultToken.address,
      10_000n,
    ]);
    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 0,
        exitCapBps: 7,
        policyActive: true,
      },
    ]);

    const vaultAsAllocator = await viem.getContractAt(
      "GRVTL1TreasuryVault",
      vault.address,
      {
        client: { public: publicClient, wallet: allocator },
      },
    );

    return {
      treasury,
      vault,
      vaultToken,
      gho,
      stkGho,
      gsm,
      staking,
      strategy,
      vaultAsAllocator,
    };
  }

  function componentTotal(
    components: ReadonlyArray<{
      readonly amount: bigint;
    }>,
  ): bigint {
    return components.reduce((sum, component) => sum + component.amount, 0n);
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

    await vault.write.setVaultTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      stratA.address,
      { whitelisted: true, active: false, cap: 2_000_000n },
    ]);
    await vault.write.setVaultTokenStrategyConfig([
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
          await vault.read.strategyPositionBreakdown([token.address, strategy]),
        );
        const remainingCap = 2_000_000n > current ? 2_000_000n - current : 0n;
        let amount = idle / 10n;
        if (amount > remainingCap) amount = remainingCap;
        if (amount > 0n) {
          await vaultAsAllocator.write.allocateVaultTokenToStrategy([
            token.address,
            strategy,
            amount,
          ]);
        }
      } else if (action === 1) {
        const strategy = strategies[Math.floor(rng() * strategies.length)];
        const sAssets = componentTotal(
          await vault.read.strategyPositionBreakdown([token.address, strategy]),
        );
        const amount = sAssets / 2n;
        if (amount > 0n) {
          await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
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
        await vault.read.strategyPositionBreakdown([
          token.address,
          stratA.address,
        ]),
      );
      const sB = componentTotal(
        await vault.read.strategyPositionBreakdown([
          token.address,
          stratB.address,
        ]),
      );
      const totals = await vault.read.tokenTotals([token.address]);
      const status = await vault.read.tokenTotalsConservative([token.address]);

      assert.equal(status.skippedStrategies, 0n);
      assert.equal(totals.total, idle + sA + sB);
      assert.equal(status.total, totals.total);
    }
  });

  it("keeps totalAssetsStatus callable in best-effort mode with reverting strategies", async function () {
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

    await vault.write.setVaultTokenConfig([
      token.address,
      {
        supported: true,
      },
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      healthy.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);
    await vault.write.setVaultTokenStrategyConfig([
      token.address,
      reverting.address,
      { whitelisted: true, active: false, cap: 0n },
    ]);

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      token.address,
      healthy.address,
      400_000n,
    ]);

    const status = await vault.read.tokenTotalsConservative([token.address]);
    const idle = await vault.read.idleTokenBalance([token.address]);
    const healthyAssets = componentTotal(
      await vault.read.strategyPositionBreakdown([
        token.address,
        healthy.address,
      ]),
    );

    assert.ok(status.skippedStrategies > 0n);
    assert.equal(status.total, idle + healthyAssets);
  });

  it("keeps V2 policy accounting coherent across tracked exits and residual harvest", async function () {
    const { treasury, vault, vaultToken, strategy, vaultAsAllocator } =
      await deployPolicyVault();

    function assertTokenTotalsCoherent(
      totals: { idle: bigint; strategy: bigint; total: bigint },
      conservative: {
        idle: bigint;
        strategy: bigint;
        total: bigint;
        skippedStrategies: bigint;
      },
      strategyVaultBalance: bigint,
    ) {
      assert.equal(totals.total, totals.idle + totals.strategy);
      assert.equal(totals.strategy, strategyVaultBalance);
      assert.equal(conservative.total, totals.total);
      assert.equal(conservative.idle, totals.idle);
      assert.equal(conservative.strategy, totals.strategy);
      assert.equal(conservative.skippedStrategies, 0n);
    }

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    const allocatedExposure = await strategy.read.totalExposure();
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      allocatedExposure,
    );
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      0n,
    );
    assertTokenTotalsCoherent(
      await vault.read.tokenTotals([vaultToken.address]),
      await vault.read.tokenTotalsConservative([vaultToken.address]),
      await vaultToken.read.balanceOf([strategy.address]),
    );

    await vaultToken.write.mint([strategy.address, 20_000n], {
      account: other.account,
    });
    const exposureAfterDust = await strategy.read.totalExposure();
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      exposureAfterDust - allocatedExposure,
    );
    assertTokenTotalsCoherent(
      await vault.read.tokenTotals([vaultToken.address]),
      await vault.read.tokenTotalsConservative([vaultToken.address]),
      await vaultToken.read.balanceOf([strategy.address]),
    );

    const treasuryBeforeTrackedExit = (await vaultToken.read.balanceOf([
      treasury.address,
    ])) as bigint;
    await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
      50_000n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      allocatedExposure - 50_000n,
    );
    const exposureAfterDeallocate = await strategy.read.totalExposure();
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      exposureAfterDeallocate - (allocatedExposure - 50_000n),
    );
    assert.ok(
      treasuryBeforeTrackedExit -
        (await vaultToken.read.balanceOf([treasury.address])) >
        0n,
    );
    assertTokenTotalsCoherent(
      await vault.read.tokenTotals([vaultToken.address]),
      await vault.read.tokenTotalsConservative([vaultToken.address]),
      await vaultToken.read.balanceOf([strategy.address]),
    );

    const harvestable = (await vault.read.harvestableYield([
      vaultToken.address,
      strategy.address,
    ])) as bigint;
    const recipient = (await vault.read.yieldRecipient()) as `0x${string}`;
    const recipientBeforeHarvest = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;
    await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      harvestable,
      0n,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      allocatedExposure - 50_000n,
    );
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      0n,
    );
    assert.ok(
      (await vaultToken.read.balanceOf([recipient])) > recipientBeforeHarvest,
    );
    assertTokenTotalsCoherent(
      await vault.read.tokenTotals([vaultToken.address]),
      await vault.read.tokenTotalsConservative([vaultToken.address]),
      await vaultToken.read.balanceOf([strategy.address]),
    );

    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      0n,
    );
    assertTokenTotalsCoherent(
      await vault.read.tokenTotals([vaultToken.address]),
      await vault.read.tokenTotalsConservative([vaultToken.address]),
      await vaultToken.read.balanceOf([strategy.address]),
    );
  });

  it("keeps tracked principal non-negative and raw harvestable yield aligned with total exposure across randomized V2 sequences", async function () {
    const seeds = [7, 41, 99];
    const sharePriceSamples = [
      1_050_000_000_000_000_000n,
      1_100_000_000_000_000_000n,
      1_250_000_000_000_000_000n,
      1_400_000_000_000_000_000n,
      1_600_000_000_000_000_000n,
    ];
    let exercisedTrackedExit = false;
    let exercisedHarvest = false;

    function assertRawHarvestableYieldIdentity(
      exposure: bigint,
      costBasis: bigint,
      harvestable: bigint,
    ) {
      assert.equal(
        harvestable,
        exposure > costBasis ? exposure - costBasis : 0n,
      );
    }

    for (const seed of seeds) {
      const {
        vault,
        vaultToken,
        gho,
        stkGho,
        staking,
        strategy,
        vaultAsAllocator,
      } = await deployPolicyVault();
      const rng = mulberry32(seed);

      for (let step = 0; step < 24; step++) {
        const trackedBefore = (await vault.read.strategyCostBasis([
          vaultToken.address,
          strategy.address,
        ])) as bigint;
        const exposureBefore = (await strategy.read.totalExposure()) as bigint;
        const harvestableBefore = (await vault.read.harvestableYield([
          vaultToken.address,
          strategy.address,
        ])) as bigint;
        assertRawHarvestableYieldIdentity(
          exposureBefore,
          trackedBefore,
          harvestableBefore,
        );

        const action = Math.floor(rng() * 6);

        if (action === 0) {
          const idle = (await vault.read.idleTokenBalance([
            vaultToken.address,
          ])) as bigint;
          const maxAmount = idle > 30_000n ? 30_000n : idle;
          if (maxAmount != 0n) {
            const amount = 1n + BigInt(Math.floor(rng() * Number(maxAmount)));
            await vaultAsAllocator.write.allocateVaultTokenToStrategy([
              vaultToken.address,
              strategy.address,
              amount,
            ]);
            const trackedAfter = (await vault.read.strategyCostBasis([
              vaultToken.address,
              strategy.address,
            ])) as bigint;
            assert.ok(trackedAfter > trackedBefore);
            assert.ok(trackedAfter <= trackedBefore + amount);
          }
        } else if (action === 1) {
          if (trackedBefore >= 1_000n) {
            const maxAmount = trackedBefore > 25_000n ? 25_000n : trackedBefore;
            const amount =
              maxAmount == 1_000n
                ? 1_000n
                : 1_000n +
                  BigInt(Math.floor(rng() * Number(maxAmount - 1_000n + 1n)));
            exercisedTrackedExit = true;

            await vaultAsAllocator.write.deallocateVaultTokenFromStrategy([
              vaultToken.address,
              strategy.address,
              amount,
            ]);

            assert.equal(
              await vault.read.strategyCostBasis([
                vaultToken.address,
                strategy.address,
              ]),
              trackedBefore - amount,
            );
          }
        } else if (action === 2) {
          const sampleIndex = Math.floor(rng() * sharePriceSamples.length);
          await staking.write.setAssetsPerShareWad([
            sharePriceSamples[sampleIndex],
          ]);
          assert.equal(
            await vault.read.strategyCostBasis([
              vaultToken.address,
              strategy.address,
            ]),
            trackedBefore,
          );
        } else if (action === 3) {
          const dust = 1n + BigInt(Math.floor(rng() * 4_000));
          const dustKind = Math.floor(rng() * 3);
          if (dustKind === 0) {
            await vaultToken.write.mint([strategy.address, dust], {
              account: other.account,
            });
          } else if (dustKind === 1) {
            await gho.write.mint([strategy.address, dust], {
              account: other.account,
            });
          } else {
            await stkGho.write.mint([strategy.address, dust], {
              account: other.account,
            });
          }
          assert.equal(
            await vault.read.strategyCostBasis([
              vaultToken.address,
              strategy.address,
            ]),
            trackedBefore,
          );
        } else if (action === 4) {
          if (harvestableBefore != 0n) {
            const amount =
              harvestableBefore > 1n
                ? harvestableBefore / 2n
                : harvestableBefore;
            exercisedHarvest = true;
            await vault.write.harvestYieldFromStrategy([
              vaultToken.address,
              strategy.address,
              amount,
              0n,
            ]);
            assert.equal(
              await vault.read.strategyCostBasis([
                vaultToken.address,
                strategy.address,
              ]),
              trackedBefore,
            );
          }
        } else {
          if (trackedBefore > 0n) {
            exercisedTrackedExit = true;
            await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
              vaultToken.address,
              strategy.address,
            ]);
            assert.equal(
              await vault.read.strategyCostBasis([
                vaultToken.address,
                strategy.address,
              ]),
              0n,
            );
          } else {
            const dust = 1n + BigInt(Math.floor(rng() * 4_000));
            await gho.write.mint([strategy.address, dust], {
              account: other.account,
            });
            assert.equal(
              await vault.read.strategyCostBasis([
                vaultToken.address,
                strategy.address,
              ]),
              trackedBefore,
            );
          }
        }

        const trackedAfter = (await vault.read.strategyCostBasis([
          vaultToken.address,
          strategy.address,
        ])) as bigint;
        const exposureAfter = (await strategy.read.totalExposure()) as bigint;
        const harvestableAfter = (await vault.read.harvestableYield([
          vaultToken.address,
          strategy.address,
        ])) as bigint;
        assertRawHarvestableYieldIdentity(
          exposureAfter,
          trackedAfter,
          harvestableAfter,
        );
        assert.ok(trackedAfter >= 0n);
      }
    }

    assert.equal(exercisedTrackedExit, true);
    assert.equal(exercisedHarvest, true);
  });

  it("clears impaired V2 cost basis and still allows final residual harvest after policy disable", async function () {
    const {
      vault,
      vaultToken,
      gho,
      stkGho,
      staking,
      strategy,
      vaultAsAllocator,
    } = await deployPolicyVault();

    await vaultAsAllocator.write.allocateVaultTokenToStrategy([
      vaultToken.address,
      strategy.address,
      100_000n,
    ]);
    await staking.write.setAssetsPerShareWad([900_000_000_000_000_000n]);

    assert.ok((await strategy.read.totalExposure()) < 100_000n);
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      0n,
    );

    await vault.write.setStrategyPolicyConfig([
      vaultToken.address,
      strategy.address,
      {
        entryCapBps: 0,
        exitCapBps: 7,
        policyActive: false,
      },
    ]);

    await vaultAsAllocator.write.deallocateAllVaultTokenFromStrategy([
      vaultToken.address,
      strategy.address,
    ]);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(await strategy.read.totalExposure(), 0n);

    await stkGho.write.mint([strategy.address, 5_000n], {
      account: other.account,
    });
    const residualExposure = await strategy.read.totalExposure();
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      residualExposure,
    );

    const recipient = (await vault.read.yieldRecipient()) as `0x${string}`;
    const recipientBefore = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;
    await vault.write.harvestYieldFromStrategy([
      vaultToken.address,
      strategy.address,
      residualExposure,
      0n,
    ]);
    const recipientAfter = (await vaultToken.read.balanceOf([
      recipient,
    ])) as bigint;

    assert.ok(recipientAfter > recipientBefore);
    assert.equal(
      await vault.read.strategyCostBasis([
        vaultToken.address,
        strategy.address,
      ]),
      0n,
    );
    assert.equal(
      await vault.read.harvestableYield([vaultToken.address, strategy.address]),
      0n,
    );
    assert.equal(await strategy.read.totalExposure(), 0n);
  });
});
