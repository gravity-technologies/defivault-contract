type DeployContractClient = any;

export async function deployVaultLibraries(viem: DeployContractClient) {
  const strategyOpsLib = await viem.deployContract("VaultStrategyOpsLib");
  const bridgeLib = await viem.deployContract("VaultBridgeLib", [], {
    libraries: {
      VaultStrategyOpsLib: strategyOpsLib.address,
    },
  });

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
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVault",
    [],
    { libraries },
  );

  return {
    strategyOpsLib,
    bridgeLib,
    libraries,
    vaultImplementation,
  };
}

export async function deployVaultV2Implementation(
  viem: DeployContractClient,
  implementationAddress: `0x${string}`,
) {
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVaultV2Mock",
    [implementationAddress],
  );

  return {
    vaultImplementation,
  };
}
