import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
} from "viem";

function proofHashFor(proofs: readonly `0x${string}`[]) {
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [proofs]));
}

describe("GsmStkGhoStrategy", async function () {
  const { viem } = await network.connect();
  const [vault, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  async function deploySystem({
    assetToGhoScale = 1n,
    cooldownSeconds = 0n,
  }: { assetToGhoScale?: bigint; cooldownSeconds?: bigint } = {}) {
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
    await gsm.write.setAssetToGhoScale([vaultToken.address, assetToGhoScale]);
    const staking = stkGho;
    await staking.write.setCooldownSeconds([cooldownSeconds]);
    const rewardsDistributor = await viem.deployContract(
      "MockAngleRewardsDistributor",
      [stkGho.address],
    );

    const implementation = await viem.deployContract("GsmStkGhoStrategy");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      vault.account.address,
    ]);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        stkGho.address,
        gsm.address,
        rewardsDistributor.address,
        "GSM_STKGHO_USDC",
      ],
    });
    const proxy = await viem.deployContract("TestBeaconProxy", [
      beacon.address,
      initializeData,
    ]);
    const strategy = await viem.getContractAt(
      "GsmStkGhoStrategy",
      proxy.address,
    );
    return {
      beacon,
      strategy,
      vaultToken,
      gho,
      stkGho,
      gsm,
      staking,
      rewardsDistributor,
    };
  }

  async function decodeStrategyLogs(strategy: any, txHash: `0x${string}`) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    return receipt.logs
      .filter(
        (log) => log.address.toLowerCase() === strategy.address.toLowerCase(),
      )
      .map((log) => {
        try {
          return decodeEventLog({
            abi: strategy.abi,
            data: log.data,
            topics: log.topics,
          });
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  it("reports the marker, allocates into stkGHO, and reports value before exit fees", async function () {
    const { strategy, beacon, vaultToken, stkGho, gho } = await deploySystem();

    assert.equal(await strategy.read.isYieldStrategyV2(), "0xa42fe856");
    assert.equal(
      (await beacon.read.owner()).toLowerCase(),
      vault.account.address.toLowerCase(),
    );
    assert.equal(
      (await strategy.read.vaultToken()).toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
    assert.equal(
      (await strategy.read.ghoToken()).toLowerCase(),
      gho.address.toLowerCase(),
    );

    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);

    const txHash = await strategy.write.allocate([100_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);

    assert.equal(await stkGho.read.balanceOf([strategy.address]), 100_000n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.totalExposure(), 100_000n);

    const breakdown = (await strategy.read.positionBreakdown()) as readonly {
      token: string;
      kind: number;
    }[];
    assert.equal(breakdown.length, 1);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      stkGho.address.toLowerCase(),
    );
    assert.equal(breakdown[0].kind, 0);

    const allocated = logs.find((log: any) => log.eventName === "Allocated") as
      | any
      | undefined;
    assert.ok(allocated);
    assert.equal(allocated.args.amountIn, 100_000n);
    assert.equal(allocated.args.invested, 100_000n);
    assert.equal(allocated.args.ghoOut, 100_000n);
    assert.equal(allocated.args.stkGhoStaked, 100_000n);
  });

  it("rejects stkGHO tokens with a non-zero cooldown", async function () {
    await assert.rejects(
      deploySystem({ cooldownSeconds: 1n }),
      /UnsupportedStkGhoCooldown/,
    );
  });

  it("rejects GSM lanes whose GHO token does not match stkGHO staking", async function () {
    const vaultToken = await viem.deployContract("MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    const gho = await viem.deployContract("MockERC20", ["GHO", "GHO", 18]);
    const otherGho = await viem.deployContract("MockERC20", [
      "Other GHO",
      "oGHO",
      18,
    ]);
    const stkGho = await viem.deployContract("MockStkGho", [gho.address]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      otherGho.address,
      vaultToken.address,
    ] as any);
    const rewardsDistributor = await viem.deployContract(
      "MockAngleRewardsDistributor",
      [stkGho.address],
    );

    const implementation = await viem.deployContract("GsmStkGhoStrategy");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      vault.account.address,
    ]);
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        stkGho.address,
        gsm.address,
        rewardsDistributor.address,
        "GSM_STKGHO_USDC",
      ],
    });

    await assert.rejects(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      /InvalidParam/,
    );
  });

  it("keeps sell-side entry fees out of invested principal and gross withdrawal amount", async function () {
    const { strategy, vaultToken, stkGho, gho, gsm } = await deploySystem();

    await gsm.write.setAssetToGhoExecutionBps([vaultToken.address, 9_900n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);

    const txHash = await strategy.write.allocate([100_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);

    const allocated = logs.find((log: any) => log.eventName === "Allocated") as
      | any
      | undefined;
    assert.ok(allocated);
    assert.equal(allocated.args.amountIn, 100_000n);
    assert.equal(allocated.args.invested, 99_000n);
    assert.equal(allocated.args.ghoOut, 99_000n);
    assert.equal(allocated.args.stkGhoStaked, 99_000n);
    assert.equal(await strategy.read.totalExposure(), 99_000n);

    await strategy.write.withdraw([99_000n]);

    assert.equal(
      await vaultToken.read.balanceOf([vault.account.address]),
      99_000n,
    );
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.totalExposure(), 0n);
  });

  it("keeps invested principal in vault-token units for scaled USDC to GHO lanes", async function () {
    const { strategy, vaultToken, stkGho, gho, gsm } = await deploySystem({
      assetToGhoScale: 1_000_000_000_000n,
    });

    await gsm.write.setAssetToGhoExecutionBps([vaultToken.address, 9_900n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);

    const txHash = await strategy.write.allocate([100_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);

    const allocated = logs.find((log: any) => log.eventName === "Allocated") as
      | any
      | undefined;
    assert.ok(allocated);
    assert.equal(allocated.args.amountIn, 100_000n);
    assert.equal(allocated.args.invested, 99_000n);
    assert.equal(allocated.args.ghoOut, 99_000_000_000_000_000n);
    assert.equal(allocated.args.stkGhoStaked, 99_000_000_000_000_000n);
    assert.equal(await strategy.read.totalExposure(), 99_000n);

    await strategy.write.withdraw([99_000n]);

    assert.equal(
      await vaultToken.read.balanceOf([vault.account.address]),
      99_000n,
    );
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.totalExposure(), 0n);
  });

  it("includes direct token balances in reported value and position breakdown", async function () {
    const { strategy, vaultToken, gho, stkGho, gsm } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);

    await gho.write.mint([strategy.address, 5n], {
      account: outsider.account,
    });
    await stkGho.write.mint([strategy.address, 3n], {
      account: outsider.account,
    });
    await vaultToken.write.mint([strategy.address, 2n], {
      account: outsider.account,
    });

    assert.equal(
      await strategy.read.exactTokenBalance([stkGho.address]),
      100_003n,
    );
    assert.equal(await strategy.read.exactTokenBalance([gho.address]), 5n);
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      2n,
    );
    assert.equal(await strategy.read.totalExposure(), 100_010n);

    const breakdown = (await strategy.read.positionBreakdown()) as readonly {
      token: string;
      kind: number;
    }[];
    assert.equal(breakdown.length, 3);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      stkGho.address.toLowerCase(),
    );
    assert.equal(breakdown[0].kind, 0);
    assert.equal(breakdown[1].token.toLowerCase(), gho.address.toLowerCase());
    assert.equal(breakdown[1].kind, 1);
    assert.equal(
      breakdown[2].token.toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
    assert.equal(breakdown[2].kind, 1);
  });

  it("reports zero exposure and an empty breakdown before any balances exist", async function () {
    const { strategy, vaultToken } = await deploySystem();

    const unsupported = await viem.deployContract("MockERC20", [
      "Unsupported",
      "UNSUP",
      18,
    ]);

    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(
      await strategy.read.exactTokenBalance([unsupported.address]),
      0n,
    );
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      0n,
    );
    assert.equal((await strategy.read.positionBreakdown()).length, 0);
  });

  it("claims stkGHO rewards and withdraws reported value with the expected exit fee", async function () {
    const { strategy, vaultToken, stkGho, gho, gsm, rewardsDistributor } =
      await deploySystem();

    const proofs = [
      "0x350b99a70072e399e62a77feb286a8ad54a3833a193d0d762da90eddb4691db1",
      "0xcdf8ba7595f375810391a20489ea8ca606e87985521ce651105318515416da45",
    ] as const;

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);

    const claimable = 10_000n;
    await stkGho.write.mint([rewardsDistributor.address, claimable], {
      account: vault.account,
    });
    await rewardsDistributor.write.setClaimable([
      strategy.address,
      stkGho.address,
      claimable,
      proofHashFor(proofs),
    ]);

    const beforeClaimExposure = await strategy.read.totalExposure();
    await strategy.write.claimStkGhoRewards([claimable, proofs], {
      account: outsider.account,
    });
    assert.equal(
      await strategy.read.totalExposure(),
      beforeClaimExposure + claimable,
    );
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 110_000n);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdraw([50_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 49_965n);
    assert.equal(await strategy.read.totalExposure(), 60_000n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 60_000n);

    const withdrawn = logs.find((log: any) => log.eventName === "Withdrawn") as
      | any
      | undefined;
    assert.ok(withdrawn);
    assert.equal(withdrawn.args.requested, 50_000n);
    assert.equal(withdrawn.args.received, 49_965n);
  });

  it("rejects malformed GSM sell and buy execution paths", async function () {
    const { strategy, vaultToken, gsm } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);

    await gsm.write.setAssetToGhoExecutionFillBps([vaultToken.address, 9_900n]);
    await assert.rejects(
      strategy.write.allocate([100_000n]),
      /UnexpectedGsmExecution/,
    );

    await gsm.write.setAssetToGhoExecutionFillBps([
      vaultToken.address,
      10_000n,
    ]);
    await strategy.write.allocate([100_000n]);

    await gsm.write.setGhoToAssetQuoteSpendBps([vaultToken.address, 10_000n]);
    await gsm.write.setGhoToAssetExecutionBps([vaultToken.address, 9_900n]);
    await assert.rejects(strategy.write.withdraw([50_000n]), /InvalidParam/);
  });

  it("sweeps idle vault-token before converting stkGHO on withdraw", async function () {
    const { strategy, vaultToken, gsm, stkGho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await vaultToken.write.mint([strategy.address, 10_000n], {
      account: outsider.account,
    });

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdraw([50_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 49_972n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 60_000n);
    assert.equal(await strategy.read.totalExposure(), 60_000n);

    const withdrawn = logs.find((log: any) => log.eventName === "Withdrawn") as
      | any
      | undefined;
    assert.ok(withdrawn);
    assert.equal(withdrawn.args.requested, 50_000n);
    assert.equal(withdrawn.args.received, 49_972n);
  });

  it("sweeps only idle vault-token when the request is below idle balance", async function () {
    const { strategy, vaultToken, gsm, stkGho, gho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await vaultToken.write.mint([strategy.address, 10_000n], {
      account: outsider.account,
    });

    const beforeExposure = await strategy.read.totalExposure();
    const beforeStk = await stkGho.read.balanceOf([strategy.address]);
    const beforeGho = await gho.read.balanceOf([strategy.address]);

    const txHash = await strategy.write.withdraw([5_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);

    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 5_000n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), beforeStk);
    assert.equal(await gho.read.balanceOf([strategy.address]), beforeGho);
    assert.equal(await strategy.read.totalExposure(), beforeExposure - 5_000n);

    const withdrawn = logs.find((log: any) => log.eventName === "Withdrawn") as
      | any
      | undefined;
    assert.ok(withdrawn);
    assert.equal(withdrawn.args.requested, 5_000n);
    assert.equal(withdrawn.args.received, 5_000n);
  });

  it("reverts reward claims with bad proofs, zero cumulative amounts, and zero delta repeats", async function () {
    const { strategy, stkGho, rewardsDistributor } = await deploySystem();

    const proofs = [
      "0x350b99a70072e399e62a77feb286a8ad54a3833a193d0d762da90eddb4691db1",
      "0xcdf8ba7595f375810391a20489ea8ca606e87985521ce651105318515416da45",
    ] as const;
    const badProof = `0x${"00".repeat(32)}` as `0x${string}`;
    const claimable = 12_345n;

    await stkGho.write.mint([rewardsDistributor.address, claimable], {
      account: outsider.account,
    });
    await rewardsDistributor.write.setClaimable([
      strategy.address,
      stkGho.address,
      claimable,
      proofHashFor(proofs),
    ]);

    await assert.rejects(
      strategy.write.claimStkGhoRewards([0n, proofs], {
        account: outsider.account,
      }),
      /InvalidParam/,
    );
    await assert.rejects(
      strategy.write.claimStkGhoRewards([claimable, [badProof]], {
        account: outsider.account,
      }),
      /InvalidProof/,
    );

    await strategy.write.claimStkGhoRewards([claimable, proofs], {
      account: outsider.account,
    });
    await assert.rejects(
      strategy.write.claimStkGhoRewards([claimable, proofs], {
        account: outsider.account,
      }),
      /InvalidParam/,
    );
  });

  it("rejects zero amounts and unauthorized callers", async function () {
    const { strategy, vaultToken } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 1n]);
    await vaultToken.write.approve([strategy.address, 1n]);

    await assert.rejects(strategy.write.allocate([0n]), /InvalidParam/);
    await assert.rejects(strategy.write.withdraw([0n]), /InvalidParam/);
    await assert.rejects(
      strategy.write.allocate([1n], { account: outsider.account }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.withdraw([1n], { account: outsider.account }),
      /Unauthorized/,
    );
  });
});
