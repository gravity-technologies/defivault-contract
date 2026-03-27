import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

import { expectEventOnce } from "../helpers/events.js";

describe("YieldRecipientTreasury", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [admin, recipient, other] = await viem.getWalletClients();

  function addr(wallet: { account?: { address: `0x${string}` } }) {
    if (wallet.account === undefined) throw new Error("wallet has no account");
    return wallet.account.address;
  }

  async function deployTreasury() {
    const treasury = await viem.deployContract("YieldRecipientTreasury", [
      addr(admin),
    ]);
    const treasuryAsOther = await viem.getContractAt(
      "YieldRecipientTreasury",
      treasury.address,
      { client: { public: publicClient, wallet: other } },
    );

    return { treasury, treasuryAsOther };
  }

  it("exposes the treasury marker interface selector", async function () {
    const { treasury } = await deployTreasury();

    assert.equal(await treasury.read.isWithdrawalFeeTreasury(), "0x3529510a");
  });

  it("lets the owner configure reimbursement policy per strategy and token", async function () {
    const { treasury, treasuryAsOther } = await deployTreasury();
    const strategyCaller = await viem.deployContract(
      "TestWithdrawalFeeTreasuryCaller",
    );
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
    ]);

    await viem.assertions.revertWithCustomError(
      treasuryAsOther.write.setReimbursementConfig([
        strategyCaller.address,
        token.address,
        true,
        1_000n,
      ]),
      treasury,
      "OwnableUnauthorizedAccount",
    );

    const hash = await treasury.write.setReimbursementConfig([
      strategyCaller.address,
      token.address,
      true,
      1_000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    assert.deepEqual(
      await treasury.read.reimbursementConfig([
        strategyCaller.address,
        token.address,
      ]),
      [true, 1_000n],
    );

    const updated = expectEventOnce(
      receipt,
      treasury,
      "ReimbursementConfigUpdated",
    );
    assert.equal(
      (updated.strategy as string).toLowerCase(),
      strategyCaller.address.toLowerCase(),
    );
    assert.equal(
      (updated.token as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(updated.enabled, true);
    assert.equal(updated.remainingBudget, 1_000n);
  });

  it("reimburses exact amounts only for enabled strategy callers within budget", async function () {
    const { treasury } = await deployTreasury();
    const strategyCaller = await viem.deployContract(
      "TestWithdrawalFeeTreasuryCaller",
    );
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
    ]);

    await token.write.mint([treasury.address, 2_000n]);
    await treasury.write.setAuthorizedVault([strategyCaller.address, true]);
    await treasury.write.setReimbursementConfig([
      strategyCaller.address,
      token.address,
      true,
      900n,
    ]);

    const recipientBefore = (await token.read.balanceOf([
      addr(recipient),
    ])) as bigint;
    const hash = await strategyCaller.write.callReimburse([
      treasury.address,
      token.address,
      strategyCaller.address,
      addr(recipient),
      250n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const recipientAfter = (await token.read.balanceOf([
      addr(recipient),
    ])) as bigint;

    assert.equal(recipientAfter - recipientBefore, 250n);
    assert.deepEqual(
      await treasury.read.reimbursementConfig([
        strategyCaller.address,
        token.address,
      ]),
      [true, 650n],
    );

    const reimbursed = expectEventOnce(
      receipt,
      treasury,
      "WithdrawalFeeReimbursed",
    );
    assert.equal(
      (reimbursed.strategy as string).toLowerCase(),
      strategyCaller.address.toLowerCase(),
    );
    assert.equal(
      (reimbursed.token as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (reimbursed.recipient as string).toLowerCase(),
      addr(recipient).toLowerCase(),
    );
    assert.equal(reimbursed.amount, 250n);
    assert.equal(reimbursed.remainingBudget, 650n);
  });

  it("returns zero instead of partially paying when disabled, over budget, or underfunded", async function () {
    const { treasury } = await deployTreasury();
    const strategyCaller = await viem.deployContract(
      "TestWithdrawalFeeTreasuryCaller",
    );
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
    ]);

    await token.write.mint([treasury.address, 100n]);

    const disabledHash = await strategyCaller.write.callReimburse([
      treasury.address,
      token.address,
      strategyCaller.address,
      addr(recipient),
      50n,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: disabledHash });
    assert.equal(await token.read.balanceOf([addr(recipient)]), 0n);

    await treasury.write.setReimbursementConfig([
      strategyCaller.address,
      token.address,
      true,
      40n,
    ]);
    const overBudgetHash = await strategyCaller.write.callReimburse([
      treasury.address,
      token.address,
      strategyCaller.address,
      addr(recipient),
      50n,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: overBudgetHash });
    assert.equal(await token.read.balanceOf([addr(recipient)]), 0n);

    await treasury.write.setReimbursementConfig([
      strategyCaller.address,
      token.address,
      true,
      200n,
    ]);
    const underfundedHash = await strategyCaller.write.callReimburse([
      treasury.address,
      token.address,
      strategyCaller.address,
      addr(recipient),
      150n,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: underfundedHash });
    assert.equal(await token.read.balanceOf([addr(recipient)]), 0n);
  });

  it("supports owner ERC20 and native withdrawals", async function () {
    const { treasury, treasuryAsOther } = await deployTreasury();
    const token = await viem.deployContract("MockERC20", [
      "Mock Token",
      "MOCK",
      18,
    ]);

    await token.write.mint([treasury.address, 700n]);
    const nativeDepositHash = await admin.sendTransaction({
      to: treasury.address,
      value: 9n,
    });
    await publicClient.waitForTransactionReceipt({ hash: nativeDepositHash });

    await viem.assertions.revertWithCustomError(
      treasuryAsOther.write.withdrawERC20([
        token.address,
        addr(recipient),
        300n,
      ]),
      treasury,
      "OwnableUnauthorizedAccount",
    );
    await viem.assertions.revertWithCustomError(
      treasuryAsOther.write.withdrawNative([addr(recipient), 4n]),
      treasury,
      "OwnableUnauthorizedAccount",
    );

    const tokenBefore = (await token.read.balanceOf([
      addr(recipient),
    ])) as bigint;
    const erc20Hash = await treasury.write.withdrawERC20([
      token.address,
      addr(recipient),
      300n,
    ]);
    const erc20Receipt = await publicClient.waitForTransactionReceipt({
      hash: erc20Hash,
    });
    const tokenAfter = (await token.read.balanceOf([
      addr(recipient),
    ])) as bigint;
    assert.equal(tokenAfter - tokenBefore, 300n);

    const nativeBefore = await publicClient.getBalance({
      address: addr(recipient),
    });
    const nativeHash = await treasury.write.withdrawNative([
      addr(recipient),
      4n,
    ]);
    const nativeReceipt = await publicClient.waitForTransactionReceipt({
      hash: nativeHash,
    });
    const nativeAfter = await publicClient.getBalance({
      address: addr(recipient),
    });
    assert.equal(nativeAfter - nativeBefore, 4n);

    const erc20Withdrawn = expectEventOnce(
      erc20Receipt,
      treasury,
      "ERC20Withdrawn",
    );
    assert.equal(
      (erc20Withdrawn.token as string).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (erc20Withdrawn.recipient as string).toLowerCase(),
      addr(recipient).toLowerCase(),
    );
    assert.equal(erc20Withdrawn.amount, 300n);

    const nativeWithdrawn = expectEventOnce(
      nativeReceipt,
      treasury,
      "NativeWithdrawn",
    );
    assert.equal(
      (nativeWithdrawn.recipient as string).toLowerCase(),
      addr(recipient).toLowerCase(),
    );
    assert.equal(nativeWithdrawn.amount, 4n);
  });

  it("accepts direct native eth transfers", async function () {
    const { treasury } = await deployTreasury();

    const before = await publicClient.getBalance({ address: treasury.address });
    const hash = await admin.sendTransaction({
      to: treasury.address,
      value: 5n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const after = await publicClient.getBalance({ address: treasury.address });

    assert.equal(after - before, 5n);
  });
});
