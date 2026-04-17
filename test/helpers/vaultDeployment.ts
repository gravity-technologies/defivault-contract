type DeployContractClient = any;

export async function deployVaultLibraries(viem: DeployContractClient) {
  const strategyOpsLib = await viem.deployContract("VaultStrategyOpsLib");
  const bridgeLib = await viem.deployContract("VaultBridgeLib");

  return {
    strategyOpsLib,
    bridgeLib,
    libraries: {
      VaultStrategyOpsLib: strategyOpsLib.address,
      VaultBridgeLib: bridgeLib.address,
    },
  };
}

export async function deployVaultImplementation(viem: DeployContractClient) {
  const { strategyOpsLib, bridgeLib, libraries } =
    await deployVaultLibraries(viem);
  const viewModule = await viem.deployContract(
    "GRVTL1TreasuryVaultViewModule",
    [],
    {
      libraries: {
        VaultStrategyOpsLib: strategyOpsLib.address,
      },
    },
  );
  const opsModule = await viem.deployContract(
    "GRVTL1TreasuryVaultOpsModule",
    [],
    {
      libraries: {
        VaultStrategyOpsLib: strategyOpsLib.address,
      },
    },
  );
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVault",
    [viewModule.address, opsModule.address],
    { libraries },
  );

  return {
    strategyOpsLib,
    bridgeLib,
    viewModule,
    opsModule,
    libraries,
    vaultImplementation,
  };
}

export async function deployLegacyVaultImplementation(
  viem: DeployContractClient,
) {
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVaultLegacyCompat",
  );

  return {
    vaultImplementation,
  };
}
