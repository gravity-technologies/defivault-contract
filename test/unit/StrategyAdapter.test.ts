import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

import { expectEventOnce } from "../helpers/events.js";

describe("Aave strategy and zkSync adapter", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const wallets = await viem.getWalletClients();
  const [admin, vaultWallet, l2ReceiverWallet, otherWallet, refundWallet] = wallets;

  const L2_GAS_LIMIT = 900_000n;
  const L2_GAS_PER_PUBDATA = 800n;

  function addr(wallet: (typeof wallets)[number]) {
    if (wallet.account === undefined) {
      throw new Error("wallet has no account");
    }
    return wallet.account.address;
  }

  describe("AaveV3Strategy", async function () {
    it("initializes with matching aToken metadata and supports vault-only operations", async function () {
      const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
      const aToken = await viem.deployContract("MockAToken");
      const pool = await viem.deployContract("MockAaveV3Pool", [token.address, aToken.address]);

      await aToken.write.setUnderlyingAsset([token.address]);
      await aToken.write.setPool([pool.address]);

      const strategyImpl = await viem.deployContract("AaveV3Strategy");
      const initData = encodeFunctionData({
        abi: strategyImpl.abi,
        functionName: "initialize",
        args: [addr(vaultWallet), pool.address, token.address, aToken.address, "AAVE_USDT"],
      });
      const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
        strategyImpl.address,
        addr(admin),
        initData,
      ]);
      const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy.address);

      assert.equal((await strategy.read.vault()).toLowerCase(), addr(vaultWallet).toLowerCase());
      assert.equal((await strategy.read.underlying()).toLowerCase(), token.address.toLowerCase());
      assert.equal((await strategy.read.aToken()).toLowerCase(), aToken.address.toLowerCase());

      await token.write.mint([addr(vaultWallet), 1_000_000n]);
      const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });
      await tokenAsVault.write.approve([strategy.address, 500_000n]);

      const strategyAsVault = await viem.getContractAt("AaveV3Strategy", strategy.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });
      const strategyAsOther = await viem.getContractAt("AaveV3Strategy", strategy.address, {
        client: { public: publicClient, wallet: otherWallet },
      });

      await strategyAsVault.write.allocate([token.address, 500_000n, "0x"]);
      await token.write.mint([strategy.address, 123n]);

      assert.equal(await strategy.read.assets([token.address]), 500_123n);

      await viem.assertions.revertWithCustomError(
        strategyAsOther.write.deallocate([token.address, 1n, "0x"]),
        strategyAsOther,
        "Unauthorized",
      );

      await strategyAsVault.write.deallocate([token.address, 200_000n, "0x"]);
      assert.equal(await strategy.read.assets([token.address]), 300_123n);

      await strategyAsVault.write.deallocateAll([token.address, "0x"]);
      assert.equal(await strategy.read.assets([token.address]), 123n);
    });

    it("reflects mocked yield accrual in assets()", async function () {
      const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
      const aToken = await viem.deployContract("MockAToken");
      const pool = await viem.deployContract("MockAaveV3Pool", [token.address, aToken.address]);

      await aToken.write.setUnderlyingAsset([token.address]);
      await aToken.write.setPool([pool.address]);

      const strategyImpl = await viem.deployContract("AaveV3Strategy");
      const initData = encodeFunctionData({
        abi: strategyImpl.abi,
        functionName: "initialize",
        args: [addr(vaultWallet), pool.address, token.address, aToken.address, "AAVE_YIELD"],
      });
      const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
        strategyImpl.address,
        addr(admin),
        initData,
      ]);
      const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy.address);

      await token.write.mint([addr(vaultWallet), 500_000n]);
      const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });
      await tokenAsVault.write.approve([strategy.address, 500_000n]);

      const strategyAsVault = await viem.getContractAt("AaveV3Strategy", strategy.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });

      await strategyAsVault.write.allocate([token.address, 200_000n, "0x"]);
      const before = await strategy.read.assets([token.address]);

      await pool.write.accrueYield([strategy.address, 10_000n]);
      const after = await strategy.read.assets([token.address]);

      assert.equal(after - before, 10_000n);
    });

    it("reverts initialize when aToken underlying does not match", async function () {
      const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
      const wrongToken = await viem.deployContract("MockERC20", ["Other", "OTH", 6]);
      const aToken = await viem.deployContract("MockAToken");
      const pool = await viem.deployContract("MockAaveV3Pool", [token.address, aToken.address]);

      await aToken.write.setUnderlyingAsset([token.address]);
      await aToken.write.setPool([pool.address]);

      const strategyImpl = await viem.deployContract("AaveV3Strategy");
      const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
        strategyImpl.address,
        addr(admin),
        "0x",
      ]);
      const strategyAsVault = await viem.getContractAt("AaveV3Strategy", proxy.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });

      await viem.assertions.revertWithCustomError(
        strategyAsVault.write.initialize([
          addr(vaultWallet),
          pool.address,
          wrongToken.address,
          aToken.address,
          "AAVE_BAD_UNDERLYING",
        ]),
        strategyAsVault,
        "InvalidATokenConfig",
      );
    });

    it("reverts initialize when aToken pool does not match", async function () {
      const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
      const aToken = await viem.deployContract("MockAToken");
      const pool = await viem.deployContract("MockAaveV3Pool", [token.address, aToken.address]);

      await aToken.write.setUnderlyingAsset([token.address]);
      await aToken.write.setPool([pool.address]);

      const strategyImpl = await viem.deployContract("AaveV3Strategy");
      const proxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
        strategyImpl.address,
        addr(admin),
        "0x",
      ]);
      const strategyAsVault = await viem.getContractAt("AaveV3Strategy", proxy.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });

      await viem.assertions.revertWithCustomError(
        strategyAsVault.write.initialize([
          addr(vaultWallet),
          addr(otherWallet),
          token.address,
          aToken.address,
          "AAVE_BAD_POOL",
        ]),
        strategyAsVault,
        "InvalidATokenConfig",
      );
    });

    it("reverts allocate on partial-fill pool due to residual underlying", async function () {
      const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
      const aToken = await viem.deployContract("MockAToken");
      const partialPool = await viem.deployContract("MockAaveV3PoolPartialFill", [
        token.address,
        aToken.address,
        5_000,
      ]);

      await aToken.write.setUnderlyingAsset([token.address]);
      await aToken.write.setPool([partialPool.address]);

      const strategyImpl = await viem.deployContract("AaveV3Strategy");
      const initData = encodeFunctionData({
        abi: strategyImpl.abi,
        functionName: "initialize",
        args: [addr(vaultWallet), partialPool.address, token.address, aToken.address, "AAVE_PARTIAL"],
      });
      const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
        strategyImpl.address,
        addr(admin),
        initData,
      ]);
      const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy.address);

      await token.write.mint([addr(vaultWallet), 100_000n]);
      const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });
      const strategyAsVault = await viem.getContractAt("AaveV3Strategy", strategy.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });

      await tokenAsVault.write.approve([strategy.address, 100_000n]);

      await viem.assertions.revertWithCustomError(
        strategyAsVault.write.allocate([token.address, 100_000n, "0x"]),
        strategyAsVault,
        "ResidualUnderlyingAfterSupply",
      );
    });
  });

  describe("ZkSyncNativeBridgeAdapter", async function () {
    async function deployAdapterFixture() {
      const token = await viem.deployContract("MockERC20", ["Mock USDT", "mUSDT", 6]);
      const zkBridge = await viem.deployContract("MockZkSyncL1Bridge");

      const adapterImpl = await viem.deployContract("ZkSyncNativeBridgeAdapter");
      const initData = encodeFunctionData({
        abi: adapterImpl.abi,
        functionName: "initialize",
        args: [addr(admin), addr(vaultWallet), zkBridge.address, addr(otherWallet)],
      });
      const adapterProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
        adapterImpl.address,
        addr(admin),
        initData,
      ]);
      const adapter = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapterProxy.address);

      const adapterAsVault = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapter.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });
      const adapterAsOther = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapter.address, {
        client: { public: publicClient, wallet: otherWallet },
      });
      const adapterAsAdmin = await viem.getContractAt("ZkSyncNativeBridgeAdapter", adapter.address, {
        client: { public: publicClient, wallet: admin },
      });

      await token.write.mint([addr(vaultWallet), 800_000n]);
      const tokenAsVault = await viem.getContractAt("MockERC20", token.address, {
        client: { public: publicClient, wallet: vaultWallet },
      });
      await tokenAsVault.write.approve([adapter.address, 800_000n]);

      return {
        token,
        zkBridge,
        adapter,
        adapterAsVault,
        adapterAsOther,
        adapterAsAdmin,
      };
    }

    it("forwards sendToL2 params and fee to zkSync bridge and enforces vault-only caller", async function () {
      const { token, zkBridge, adapter, adapterAsVault, adapterAsOther } = await deployAdapterFixture();

      const feeValue = 210_000n;
      const hash = await adapterAsVault.write.sendToL2(
        [
          token.address,
          300_000n,
          addr(l2ReceiverWallet),
          L2_GAS_LIMIT,
          L2_GAS_PER_PUBDATA,
          addr(refundWallet),
        ],
        { value: feeValue },
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await token.read.balanceOf([zkBridge.address]), 300_000n);
      assert.equal((await zkBridge.read.lastL1Token()).toLowerCase(), token.address.toLowerCase());
      assert.equal(
        (await zkBridge.read.lastL2Receiver()).toLowerCase(),
        addr(l2ReceiverWallet).toLowerCase(),
      );
      assert.equal(await zkBridge.read.lastAmount(), 300_000n);
      assert.equal(await zkBridge.read.lastL2TxGasLimit(), L2_GAS_LIMIT);
      assert.equal(await zkBridge.read.lastL2TxGasPerPubdataByte(), L2_GAS_PER_PUBDATA);
      assert.equal((await zkBridge.read.lastRefundRecipient()).toLowerCase(), addr(refundWallet).toLowerCase());
      assert.equal(await zkBridge.read.lastMsgValue(), feeValue);

      const sentEvent = expectEventOnce(receipt, adapter, "SentToL2");
      assert.equal(sentEvent.bridgeTxHash, await zkBridge.read.lastTxHash());

      await viem.assertions.revertWithCustomError(
        adapterAsOther.write.sendToL2([
          token.address,
          10_000n,
          addr(l2ReceiverWallet),
          L2_GAS_LIMIT,
          L2_GAS_PER_PUBDATA,
          addr(refundWallet),
        ]),
        adapterAsOther,
        "Unauthorized",
      );
    });

    it("supports timelocked propose/apply/cancel flows and blocks re-proposal while pending", async function () {
      const { adapterAsAdmin, adapter } = await deployAdapterFixture();

      const newVault = addr(refundWallet);
      await adapterAsAdmin.write.proposeVaultUpdate([newVault]);

      assert.equal((await adapter.read.pendingVault()).toLowerCase(), newVault.toLowerCase());
      await viem.assertions.revertWithCustomError(
        adapterAsAdmin.write.proposeVaultUpdate([addr(l2ReceiverWallet)]),
        adapterAsAdmin,
        "PendingUpdateExists",
      );

      await viem.assertions.revertWithCustomError(
        adapterAsAdmin.write.applyVaultUpdate(),
        adapterAsAdmin,
        "PendingUpdateNotReady",
      );

      await testClient.increaseTime({ seconds: 24 * 60 * 60 + 1 });
      await testClient.mine({ blocks: 1 });

      await adapterAsAdmin.write.applyVaultUpdate();
      assert.equal((await adapter.read.vault()).toLowerCase(), newVault.toLowerCase());
      assert.equal(await adapter.read.pendingVault(), "0x0000000000000000000000000000000000000000");
      assert.equal(await adapter.read.pendingVaultReadyAt(), 0n);

      await adapterAsAdmin.write.proposeVaultUpdate([addr(vaultWallet)]);
      await adapterAsAdmin.write.cancelVaultUpdate();
      assert.equal(await adapter.read.pendingVault(), "0x0000000000000000000000000000000000000000");

      const newBridge = addr(l2ReceiverWallet);
      await adapterAsAdmin.write.proposeZkSyncBridgeUpdate([newBridge]);
      assert.equal((await adapter.read.pendingZkSyncBridge()).toLowerCase(), newBridge.toLowerCase());

      await viem.assertions.revertWithCustomError(
        adapterAsAdmin.write.proposeZkSyncBridgeUpdate([addr(otherWallet)]),
        adapterAsAdmin,
        "PendingUpdateExists",
      );

      await adapterAsAdmin.write.cancelZkSyncBridgeUpdate();
      assert.equal(
        await adapter.read.pendingZkSyncBridge(),
        "0x0000000000000000000000000000000000000000",
      );

      await adapterAsAdmin.write.proposeZkSyncBridgeUpdate([newBridge]);
      await testClient.increaseTime({ seconds: 24 * 60 * 60 + 1 });
      await testClient.mine({ blocks: 1 });
      await adapterAsAdmin.write.applyZkSyncBridgeUpdate();
      assert.equal((await adapter.read.zkSyncBridge()).toLowerCase(), newBridge.toLowerCase());
    });

    it("accepts bridge fee refunds on adapter receive path", async function () {
      const { token, zkBridge, adapter, adapterAsVault } = await deployAdapterFixture();

      await zkBridge.write.setRefundBehavior([true, 100_000n]);

      const adapterBalanceBefore = await publicClient.getBalance({ address: adapter.address });
      await adapterAsVault.write.sendToL2(
        [
          token.address,
          100_000n,
          addr(l2ReceiverWallet),
          L2_GAS_LIMIT,
          L2_GAS_PER_PUBDATA,
          addr(refundWallet),
        ],
        { value: 200_000n },
      );

      const adapterBalanceAfter = await publicClient.getBalance({ address: adapter.address });
      assert.equal(adapterBalanceAfter, adapterBalanceBefore + 100_000n);
    });
  });
});
