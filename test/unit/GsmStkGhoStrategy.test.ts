import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData } from "viem";

describe("GsmStkGhoStrategy", async function () {
  const { viem } = await network.connect();
  const [vault, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  function ceilGrossForNet(amountOut: bigint, feeBps: bigint) {
    const bpsScale = 10_000n;
    return (
      (amountOut * bpsScale + (bpsScale - feeBps - 1n)) / (bpsScale - feeBps)
    );
  }

  function feeForGross(amountIn: bigint, feeBps: bigint) {
    return (amountIn * feeBps) / 10_000n;
  }

  async function deploySystem() {
    const vaultToken = await viem.deployContract("MockERC20", [
      "USD Coin",
      "USDC",
      6,
    ]);
    const gho = await viem.deployContract("MockERC20", ["GHO", "GHO", 18]);
    const stkGho = await viem.deployContract("MockERC20", [
      "Staked GHO",
      "stkGHO",
      18,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [gho.address]);
    const staking = await viem.deployContract("MockStkGhoStaking", [
      gho.address,
      stkGho.address,
    ]);

    const implementation = await viem.deployContract("GsmStkGhoStrategy");
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        vault.account.address,
        vaultToken.address,
        gho.address,
        stkGho.address,
        gsm.address,
        staking.address,
        "GSM_STKGHO_USDC",
      ],
    });
    const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
      implementation.address,
      vault.account.address,
      initializeData,
    ]);
    const strategy = await viem.getContractAt(
      "GsmStkGhoStrategy",
      proxy.address,
    );

    return { strategy, vaultToken, gho, stkGho, gsm, staking };
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

  it("allocates through gsm and staking into direct stkGHO exposure", async function () {
    const { strategy, vaultToken, stkGho, gho, gsm } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);

    await strategy.write.allocate([100_000n]);

    assert.equal(await stkGho.read.balanceOf([strategy.address]), 100_000n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure(), 99_930n);
  });

  it("reports exact balances and breakdowns for residual tokens", async function () {
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

    const breakdown = await strategy.read.positionBreakdown();
    assert.equal(breakdown.length, 3);
    assert.equal(
      breakdown[0].token.toLowerCase(),
      stkGho.address.toLowerCase(),
    );
    assert.equal(breakdown[1].token.toLowerCase(), gho.address.toLowerCase());
    assert.equal(
      breakdown[2].token.toLowerCase(),
      vaultToken.address.toLowerCase(),
    );

    assert.equal(await strategy.read.strategyExposure(), 99_940n);
    assert.equal(await strategy.read.residualExposure(), 10n);
  });

  it("uses staking conversion previews when stkGHO assets-per-share drifts upward", async function () {
    const { strategy, vaultToken, gsm, staking } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await staking.write.setAssetsPerShareWad([1_200_000_000_000_000_000n]);

    assert.equal(await strategy.read.strategyExposure(), 119_916n);
    assert.equal(await strategy.read.residualExposure(), 19_986n);
  });

  it("does not let sub-share GHO dust brick tracked exits after share-price drift", async function () {
    const { strategy, vaultToken, gsm, staking, gho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await staking.write.setAssetsPerShareWad([1_200_000_000_000_000_000n]);
    await gho.write.mint([strategy.address, 1n], {
      account: outsider.account,
    });

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    await strategy.write.withdrawTracked([1n]);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 1n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 1n);
  });

  it("reports the V2 marker and the configured lane token", async function () {
    const { strategy, vaultToken } = await deploySystem();

    assert.equal(await strategy.read.isYieldStrategyV2(), "0xa42fe856");
    assert.equal(
      (await strategy.read.vaultToken()).toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
  });

  it("withdrawResidual remains reimbursement-free on partial exits", async function () {
    const { strategy, vaultToken, gsm, stkGho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await vaultToken.write.mint([strategy.address, 50_000n], {
      account: outsider.account,
    });

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawResidual([50_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 50_000n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 100_000n);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 50_000n);
    assert.equal(deallocated.args.reimbursableFee, 0n);
  });

  it("tracked deallocate reports tracked-only receipt and the exact exit fee paid", async function () {
    const { strategy, vaultToken, gsm, stkGho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawTracked([50_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    const fee = feeForGross(50_000n, 7n);
    assert.equal(afterVault - beforeVault, 49_965n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 50_000n);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 49_965n);
    assert.equal(deallocated.args.reimbursableFee, fee);
  });

  it("converts vault-token tracked amounts into gross GHO exposure before consuming tracked value", async function () {
    const { strategy, vaultToken, gsm, stkGho } = await deploySystem();

    await gsm.write.setAssetToGhoScale([
      vaultToken.address,
      1_000_000_000_000n,
    ]);
    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000_000n]);
    await vaultToken.write.approve([strategy.address, 100_000_000n]);
    await strategy.write.allocate([100_000_000n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawTracked([50_000_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 49_965_000n);
    assert.equal(
      await stkGho.read.balanceOf([strategy.address]),
      50_000_000_000_000_000_000n,
    );

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 49_965_000n);
    assert.equal(deallocated.args.reimbursableFee, 35_000n);
  });

  it("tracked deallocate ignores idle residual vault-token balance", async function () {
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
    const txHash = await strategy.write.withdrawTracked([50_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    const fee = feeForGross(50_000n, 7n);
    assert.equal(afterVault - beforeVault, 49_965n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 50_000n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 10_000n);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 49_965n);
    assert.equal(deallocated.args.reimbursableFee, fee);
  });

  it("tracked deallocate does not treat idle vault-token residual as tracked value", async function () {
    const { strategy, vaultToken, gsm, stkGho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await vaultToken.write.mint([strategy.address, 12_000n], {
      account: outsider.account,
    });

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawTracked([10_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.equal(afterVault - beforeVault, 9_993n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 90_000n);
    assert.equal(await vaultToken.read.balanceOf([strategy.address]), 12_000n);
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 9_993n);
    assert.equal(deallocated.args.reimbursableFee, 7n);
  });

  it("withdrawResidual realizes only residual value and leaves tracked value untouched", async function () {
    const { strategy, vaultToken, gho, stkGho, gsm } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await gho.write.mint([strategy.address, 5_000n], {
      account: outsider.account,
    });
    await stkGho.write.mint([strategy.address, 10_000n], {
      account: outsider.account,
    });

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawResidual([12_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterResidualVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);

    assert.equal(afterResidualVault - beforeVault, 12_000n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 102_991n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 12_000n);
    assert.equal(deallocated.args.reimbursableFee, 0n);

    const trackedTxHash = await strategy.write.withdrawTracked([100_000n]);
    const trackedLogs = await decodeStrategyLogs(strategy, trackedTxHash);
    const afterTrackedVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);

    assert.equal(afterTrackedVault - afterResidualVault, 99_930n);
    const trackedDeallocated = trackedLogs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(trackedDeallocated);
    assert.equal(trackedDeallocated.args.received, 99_930n);
    assert.equal(trackedDeallocated.args.reimbursableFee, 70n);
  });

  it("withdraws tracked value first, then drains the remaining residual position", async function () {
    const { strategy, vaultToken, gsm, gho, stkGho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const trackedTxHash = await strategy.write.withdrawAllTracked();
    const trackedLogs = await decodeStrategyLogs(strategy, trackedTxHash);
    const afterTrackedVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);

    assert.equal(afterTrackedVault - beforeVault, 99_930n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await stkGho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.strategyExposure(), 0n);
    assert.equal(await strategy.read.residualExposure(), 0n);

    const deallocated = trackedLogs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.requested, 2n ** 256n - 1n);
    assert.equal(deallocated.args.received, 99_930n);
    assert.equal(deallocated.args.reimbursableFee, 70n);

    const residualTxHash = await strategy.write.withdrawAllResidual();
    const residualLogs = await decodeStrategyLogs(strategy, residualTxHash);
    const afterResidualVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);

    assert.equal(afterResidualVault - afterTrackedVault, 0n);
    const residualDeallocated = residualLogs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(residualDeallocated);
    assert.equal(residualDeallocated.args.requested, 2n ** 256n - 1n);
    assert.equal(residualDeallocated.args.received, 0n);
    assert.equal(residualDeallocated.args.reimbursableFee, 0n);
  });

  it("tracked deallocate can report the full unwind fee on a final tracked exit", async function () {
    const { strategy, vaultToken, gsm } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawTracked([100_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.equal(afterVault - beforeVault, 99_930n);
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 99_930n);
    assert.equal(deallocated.args.reimbursableFee, 70n);
  });

  it("leaves appreciated stkGHO value on the residual path after consuming tracked vault-funded value", async function () {
    const { strategy, vaultToken, gsm, staking, gho } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await staking.write.setAssetsPerShareWad([2_000_000_000_000_000_000n]);

    const beforeVault = await vaultToken.read.balanceOf([
      vault.account.address,
    ]);
    const txHash = await strategy.write.withdrawTracked([100_000n]);
    const logs = await decodeStrategyLogs(strategy, txHash);
    const afterVault = await vaultToken.read.balanceOf([vault.account.address]);

    assert.equal(afterVault - beforeVault, 99_930n);
    assert.equal(await gho.read.balanceOf([strategy.address]), 0n);
    assert.equal(await strategy.read.residualExposure(), 99_930n);

    const deallocated = logs.find(
      (log: any) => log.eventName === "Deallocated",
    ) as any;
    assert.ok(deallocated);
    assert.equal(deallocated.args.received, 99_930n);
    assert.equal(deallocated.args.reimbursableFee, 70n);
  });

  it("returns zero for unsupported exact-token reads and restricts mutations to the vault", async function () {
    const { strategy, vaultToken, gho } = await deploySystem();

    assert.equal(
      await strategy.read.exactTokenBalance([outsider.account.address]),
      0n,
    );
    const breakdown = await strategy.read.positionBreakdown();
    assert.equal(breakdown.length, 0);

    await assert.rejects(
      strategy.write.allocate([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
    await assert.rejects(
      strategy.write.withdrawTracked([1n], {
        account: outsider.account,
      }),
      /Unauthorized/,
    );
  });

  it("reverts allocate when GSM execution returns less GHO than previewed", async function () {
    const { strategy, vaultToken, gsm } = await deploySystem();

    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await gsm.write.setAssetToGhoExecutionBps([vaultToken.address, 9_999n]);

    await assert.rejects(strategy.write.allocate([100_000n]), /InvalidParam/);
  });

  it("reverts withdrawTracked when GSM execution returns less asset than previewed", async function () {
    const { strategy, vaultToken, gsm } = await deploySystem();

    await gsm.write.setBurnFeeBps([vaultToken.address, 7n]);
    await vaultToken.write.mint([vault.account.address, 100_000n]);
    await vaultToken.write.approve([strategy.address, 100_000n]);
    await strategy.write.allocate([100_000n]);
    await gsm.write.setGhoToAssetExecutionBps([vaultToken.address, 9_999n]);

    await assert.rejects(
      strategy.write.withdrawTracked([50_000n]),
      /InvalidParam/,
    );
  });
});
