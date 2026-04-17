import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

describe("SGHOStrategy", async function () {
  const { viem } = await network.connect();
  const [vault] = await viem.getWalletClients();

  function addr(wallet: { account?: { address: `0x${string}` } }) {
    if (wallet.account === undefined) throw new Error("wallet has no account");
    return wallet.account.address;
  }

  async function deployBase() {
    const vaultToken = await viem.deployContract("MockERC20", [
      "USD Token",
      "USDT",
      6,
    ]);
    const gho = await viem.deployContract("MockERC20", ["GHO", "GHO", 18]);
    const sGho = await viem.deployContract("MockSgho", [gho.address]);
    const implementation = await viem.deployContract("SGHOStrategy");
    const beacon = await viem.deployContract("TestUpgradeableBeacon", [
      implementation.address,
      addr(vault),
    ]);

    return { vaultToken, gho, sGho, implementation, beacon };
  }

  async function deployWrappedRoute() {
    const { vaultToken, gho, sGho, implementation, beacon } =
      await deployBase();
    const mockPool = await viem.deployContract("MockNonERC20");
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultToken.address,
      mockPool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    const stataToken = await viem.deployContract("MockStataTokenV2", [
      aToken.address,
      vaultToken.address,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      stataToken.address,
    ]);
    const strategy = await deployProxy(implementation, beacon, [
      addr(vault),
      vaultToken.address,
      sGho.address,
      gsm.address,
      "SGHO_USDT",
    ]);

    return { vaultToken, gho, sGho, aToken, stataToken, gsm, strategy };
  }

  async function deployProxy(
    implementation: any,
    beacon: any,
    args: readonly [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
      string,
    ],
  ) {
    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args,
    });
    const proxy = await viem.deployContract("TestBeaconProxy", [
      beacon.address,
      initializeData,
    ]);
    return viem.getContractAt("SGHOStrategy", proxy.address);
  }

  it("initializes when the GSM underlying asset is a wrapped stata token over the explicit vault token", async function () {
    const { vaultToken, stataToken, gsm, strategy } =
      await deployWrappedRoute();

    assert.equal(
      (await strategy.read.vaultToken()).toLowerCase(),
      vaultToken.address.toLowerCase(),
    );
    assert.equal(
      (await strategy.read.gsmStataToken()).toLowerCase(),
      stataToken.address.toLowerCase(),
    );
    assert.equal(
      (await strategy.read.ghoGsm()).toLowerCase(),
      gsm.address.toLowerCase(),
    );
  });

  it("reverts when the GSM underlying asset is the direct vault token instead of a stata token", async function () {
    const { vaultToken, gho, sGho, implementation, beacon } =
      await deployBase();
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      vaultToken.address,
    ]);

    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        addr(vault),
        vaultToken.address,
        sGho.address,
        gsm.address,
        "SGHO_USDT",
      ],
    });

    await viem.assertions.revertWithCustomError(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      implementation,
      "InvalidInitializationParams",
    );
  });

  it("reverts when the wrapped GSM asset does not resolve back to the explicit vault token", async function () {
    const { gho, sGho, implementation, beacon } = await deployBase();
    const vaultToken = await viem.deployContract("MockERC20", [
      "USD Token",
      "USDT",
      6,
    ]);
    const otherVaultToken = await viem.deployContract("MockERC20", [
      "Other USD",
      "USDC",
      6,
    ]);
    const mockPool = await viem.deployContract("MockNonERC20");
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      otherVaultToken.address,
      mockPool.address,
      "Aave USDC",
      "aUSDC",
    ]);
    const stataToken = await viem.deployContract("MockStataTokenV2", [
      aToken.address,
      otherVaultToken.address,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      stataToken.address,
    ]);

    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        addr(vault),
        vaultToken.address,
        sGho.address,
        gsm.address,
        "SGHO_USDT",
      ],
    });

    await viem.assertions.revertWithCustomError(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      implementation,
      "InvalidInitializationParams",
    );
  });

  it("reverts when the wrapped GSM asset reports a different ERC4626 asset than the vault token", async function () {
    const { vaultToken, gho, sGho, implementation, beacon } =
      await deployBase();
    const otherVaultToken = await viem.deployContract("MockERC20", [
      "Other USD",
      "USDC",
      6,
    ]);
    const mockPool = await viem.deployContract("MockNonERC20");
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultToken.address,
      mockPool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    const stataToken = await viem.deployContract("MockStataTokenV2", [
      aToken.address,
      otherVaultToken.address,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      stataToken.address,
    ]);

    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        addr(vault),
        vaultToken.address,
        sGho.address,
        gsm.address,
        "SGHO_USDT",
      ],
    });

    await viem.assertions.revertWithCustomError(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      implementation,
      "InvalidInitializationParams",
    );
  });

  it("reverts when the GSM asset is not a stata token", async function () {
    const { vaultToken, gho, sGho, implementation, beacon } =
      await deployBase();
    const nonStataAsset = await viem.deployContract("MockNonERC20");
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      nonStataAsset.address,
    ]);

    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        addr(vault),
        vaultToken.address,
        sGho.address,
        gsm.address,
        "SGHO_USDT",
      ],
    });

    await viem.assertions.revertWithCustomError(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      implementation,
      "InvalidInitializationParams",
    );
  });

  it("reverts when the GSM price ratio is not 1:1", async function () {
    const { vaultToken, gho, sGho, implementation, beacon } =
      await deployBase();
    const mockPool = await viem.deployContract("MockNonERC20");
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultToken.address,
      mockPool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    const stataToken = await viem.deployContract("MockStataTokenV2", [
      aToken.address,
      vaultToken.address,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      stataToken.address,
    ]);
    await gsm.write.setPriceRatio([999_999_999_999_999_999n]);

    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        addr(vault),
        vaultToken.address,
        sGho.address,
        gsm.address,
        "SGHO_USDT",
      ],
    });

    await viem.assertions.revertWithCustomError(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      implementation,
      "InvalidGsmConfig",
    );
  });

  it("reverts when the GSM charges a sell fee at initialization", async function () {
    const { vaultToken, gho, sGho, implementation, beacon } =
      await deployBase();
    const mockPool = await viem.deployContract("MockNonERC20");
    const aToken = await viem.deployContract("MockAaveV3AToken", [
      vaultToken.address,
      mockPool.address,
      "Aave USDT",
      "aUSDT",
    ]);
    const stataToken = await viem.deployContract("MockStataTokenV2", [
      aToken.address,
      vaultToken.address,
    ]);
    const gsm = await viem.deployContract("MockAaveGsm", [
      gho.address,
      stataToken.address,
    ]);
    await gsm.write.setAssetToGhoQuoteBps([stataToken.address, 9_999n]);

    const initializeData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [
        addr(vault),
        vaultToken.address,
        sGho.address,
        gsm.address,
        "SGHO_USDT",
      ],
    });

    await viem.assertions.revertWithCustomError(
      viem.deployContract("TestBeaconProxy", [beacon.address, initializeData]),
      implementation,
      "InvalidGsmConfig",
    );
  });

  it("uses the actual stata shares sold when normalizing invested principal", async function () {
    const { vaultToken, sGho, stataToken, strategy } =
      await deployWrappedRoute();

    await stataToken.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);

    await vaultToken.write.mint([addr(vault), 100_000_000n]);
    await vaultToken.write.approve([strategy.address, 100_000_000n]);
    await strategy.write.allocate([100_000_000n]);

    assert.equal(await strategy.read.totalExposure(), 99_999_999n);
    assert.equal(await strategy.read.withdrawableExposure(), 99_999_999n);
    assert.equal(
      await strategy.read.exactTokenBalance([sGho.address]),
      99_999_999n,
    );
    assert.equal(await stataToken.read.balanceOf([strategy.address]), 0n);
  });

  it("allows allocation even when the route carries entry loss", async function () {
    const { vaultToken, stataToken, strategy, gsm } =
      await deployWrappedRoute();

    await gsm.write.setAssetToGhoExecutionBps([stataToken.address, 9_999n]);
    await gsm.write.setAssetToGhoQuoteBps([stataToken.address, 9_999n]);

    await vaultToken.write.mint([addr(vault), 100_000_000n]);
    await vaultToken.write.approve([strategy.address, 100_000_000n]);

    await strategy.write.allocate([100_000_000n]);

    assert.equal(await strategy.read.totalExposure(), 99_990_000n);
    assert.equal(await strategy.read.withdrawableExposure(), 99_990_000n);
  });

  it("allows allocation when sGHO mint rounding leaves small entry dust", async function () {
    const { vaultToken, sGho, strategy } = await deployWrappedRoute();

    await sGho.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);

    await vaultToken.write.mint([addr(vault), 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);

    await strategy.write.allocate([100n]);

    assert.equal(await strategy.read.totalExposure(), 99n);
    assert.equal(await strategy.read.withdrawableExposure(), 99n);
  });

  it("withdraws without over-return when stata appreciates above par", async function () {
    const { vaultToken, stataToken, strategy } = await deployWrappedRoute();

    await stataToken.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);

    await vaultToken.write.mint([addr(vault), 100_000_000n]);
    await vaultToken.write.approve([strategy.address, 100_000_000n]);
    await strategy.write.allocate([100_000_000n]);

    await strategy.write.withdraw([100_000_000n]);

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 99_999_999n);
    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(await strategy.read.withdrawableExposure(), 0n);
  });

  it("uses previewWithdraw sizing on exit when stata appreciates above par", async function () {
    const { vaultToken, sGho, stataToken, gsm, strategy } =
      await deployWrappedRoute();

    await stataToken.write.setAssetsPerShareWad([1_000_000_000_000_000_001n]);

    await vaultToken.write.mint([addr(vault), 100_000_000n]);
    await vaultToken.write.approve([strategy.address, 100_000_000n]);
    await strategy.write.allocate([100_000_000n]);

    await sGho.write.setAssetsPerShareWad([1_010_000_000_000_000_000n]);
    await sGho.write.mintBacking([1_000_000n]);
    await vaultToken.write.mint([addr(vault), 2n]);
    await vaultToken.write.approve([stataToken.address, 2n]);
    await stataToken.write.deposit([2n, gsm.address]);

    assert.equal(await strategy.read.totalExposure(), 100_999_998n);
    assert.equal(await strategy.read.withdrawableExposure(), 100_999_998n);

    await strategy.write.withdraw([100_000_000n]);

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 100_000_000n);
    assert.equal(await strategy.read.totalExposure(), 999_998n);
    assert.equal(await strategy.read.withdrawableExposure(), 999_998n);
  });

  it("withdraws using the GSM buy quote even when it spends less than the budget", async function () {
    const { vaultToken, sGho, stataToken, strategy, gsm } =
      await deployWrappedRoute();

    await gsm.write.setGhoToAssetQuoteSpendBps([stataToken.address, 9_900n]);

    await vaultToken.write.mint([addr(vault), 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    await strategy.write.withdraw([100n]);

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 99n);
    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(await strategy.read.withdrawableExposure(), 0n);
    assert.equal(
      await strategy.read.exactTokenBalance([stataToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([sGho.address]), 0n);
  });

  it("allocates and withdraws through the wrapped stata GSM route", async function () {
    const { vaultToken, gho, sGho, stataToken, gsm, strategy } =
      await deployWrappedRoute();

    await vaultToken.write.mint([addr(vault), 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    assert.equal(await strategy.read.totalExposure(), 100n);
    assert.equal(await strategy.read.withdrawableExposure(), 100n);
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([gho.address]), 0n);
    assert.equal(
      await strategy.read.exactTokenBalance([stataToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([sGho.address]), 100n);
    assert.equal(await stataToken.read.balanceOf([gsm.address]), 100n);

    await strategy.write.withdraw([40n]);

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 40n);
    assert.equal(await strategy.read.totalExposure(), 60n);
    assert.equal(await strategy.read.withdrawableExposure(), 60n);
    assert.equal(
      await strategy.read.exactTokenBalance([vaultToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([gho.address]), 0n);
    assert.equal(
      await strategy.read.exactTokenBalance([stataToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([sGho.address]), 60n);
    assert.equal(await stataToken.read.balanceOf([gsm.address]), 60n);
  });

  it("uses idle stata inventory before unwinding sGHO", async function () {
    const { vaultToken, gho, sGho, stataToken, strategy } =
      await deployWrappedRoute();

    await vaultToken.write.mint([addr(vault), 120n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    await vaultToken.write.approve([stataToken.address, 20n]);
    await stataToken.write.deposit([20n, strategy.address]);

    assert.equal(
      await strategy.read.exactTokenBalance([stataToken.address]),
      20n,
    );
    assert.equal(await strategy.read.totalExposure(), 120n);

    await strategy.write.withdraw([20n]);

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 20n);
    assert.equal(
      await strategy.read.exactTokenBalance([stataToken.address]),
      0n,
    );
    assert.equal(await strategy.read.exactTokenBalance([gho.address]), 0n);
    assert.equal(await strategy.read.exactTokenBalance([sGho.address]), 100n);
    assert.equal(await strategy.read.totalExposure(), 100n);
    assert.equal(await gho.read.balanceOf([sGho.address]), 100n);
  });

  it("keeps exposure pre-fee and returns net proceeds on the GSM buy path", async function () {
    const { vaultToken, stataToken, strategy, gsm } =
      await deployWrappedRoute();

    await gsm.write.setBurnFeeBps([stataToken.address, 200n]);
    await gsm.write.setGhoToAssetQuoteSpendBps([stataToken.address, 9_900n]);

    await vaultToken.write.mint([addr(vault), 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    assert.equal(await strategy.read.totalExposure(), 100n);
    assert.equal(await strategy.read.withdrawableExposure(), 100n);

    await strategy.write.withdraw([100n]);

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 98n);
    assert.equal(await strategy.read.totalExposure(), 0n);
    assert.equal(await strategy.read.withdrawableExposure(), 0n);
  });

  it("reverts withdraw when sGHO liquidity cannot cover the required GHO", async function () {
    const { vaultToken, sGho, strategy } = await deployWrappedRoute();

    await vaultToken.write.mint([addr(vault), 100n]);
    await vaultToken.write.approve([strategy.address, 100n]);
    await strategy.write.allocate([100n]);

    await sGho.write.setWithdrawalLimit([99n]);

    await viem.assertions.revertWithCustomError(
      strategy.write.withdraw([100n]),
      strategy,
      "InsufficientRedeemableLiquidity",
    );

    assert.equal(await vaultToken.read.balanceOf([addr(vault)]), 0n);
    assert.equal(await strategy.read.totalExposure(), 100n);
    assert.equal(await strategy.read.withdrawableExposure(), 99n);
  });
});
