import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress, type Hex } from "viem";

import {
  getClients,
  readModuleParams,
  requireAddress,
  requireBoolean,
  requireHexData,
  resolveParametersPath,
} from "../utils/one-off-ops.js";
import { proxyAdminAbi } from "../utils/proxy-admin.js";
import {
  createUpgradeRecord,
  encodeProxyUpgradeCalldata,
  executeProxyUpgrade,
  finalizeDirectUpgrade,
  resolveProxyUpgradeContext,
} from "../utils/proxy-upgrade.js";

type VaultUpgradeTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<VaultUpgradeTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "VaultUpgradeTask");
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
  const requiresMultisig = requireBoolean(params, "requiresMultisig", filePath);
  const upgradeCallData: Hex =
    params.upgradeCallData === undefined
      ? ("0x" as Hex)
      : requireHexData(params, "upgradeCallData", filePath);
  const { viem, publicClient, walletClient } = await getClients(hre);
  const signerAddress = getAddress(walletClient.account.address);
  const context = await resolveProxyUpgradeContext({
    filePath,
    hre,
    proxy: vaultProxy,
    signer: signerAddress,
  });
  const proxyAdminOwner = await publicClient.readContract({
    address: context.proxyAdmin,
    abi: proxyAdminAbi,
    functionName: "owner",
  });

  const client = {
    public: publicClient,
    wallet: walletClient,
  } as const;

  const vaultStrategyOpsLib = await viem.deployContract(
    "VaultStrategyOpsLib",
    [],
    { client },
  );
  const vaultBridgeLib = await viem.deployContract("VaultBridgeLib", [], {
    client,
    libraries: {
      VaultStrategyOpsLib: vaultStrategyOpsLib.address,
    },
  });
  const vaultViewModule = await viem.deployContract(
    "GRVTL1TreasuryVaultViewModule",
    [],
    {
      client,
      libraries: {
        VaultStrategyOpsLib: vaultStrategyOpsLib.address,
      },
    },
  );
  const vaultOpsModule = await viem.deployContract(
    "GRVTL1TreasuryVaultOpsModule",
    [],
    {
      client,
      libraries: {
        VaultStrategyOpsLib: vaultStrategyOpsLib.address,
      },
    },
  );
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVault",
    [vaultViewModule.address, vaultOpsModule.address],
    {
      client,
      libraries: {
        VaultBridgeLib: vaultBridgeLib.address,
        VaultStrategyOpsLib: vaultStrategyOpsLib.address,
      },
    },
  );
  const upgradeCalldata = encodeProxyUpgradeCalldata({
    implementation: vaultImplementation.address,
    proxy: vaultProxy,
    upgradeCallData,
  });
  const prepared = createUpgradeRecord({
    callData: upgradeCalldata,
    chainId: context.chainId,
    environment: context.environment,
    filePath,
    forcePrepare: requiresMultisig,
    implementation: vaultImplementation.address,
    kind: "vault-upgrade",
    longLivedAuthority: context.longLivedAuthority,
    network: context.network,
    proxy: vaultProxy,
    proxyAdmin: context.proxyAdmin,
    proxyAdminOwner: getAddress(proxyAdminOwner),
    repoRoot: context.repoRoot,
    resolvedInputs: {
      requiresMultisig,
      upgradeCallData,
      vaultProxy,
    },
    signer: signerAddress,
    summary: [
      "# Vault upgrade",
      "",
      `- Vault proxy: \`${vaultProxy}\``,
      `- ProxyAdmin: \`${context.proxyAdmin}\``,
      `- ProxyAdmin owner: \`${proxyAdminOwner}\``,
      `- Signer: \`${signerAddress}\``,
      `- Requires multisig: \`${String(requiresMultisig)}\``,
      `- Vault implementation: \`${vaultImplementation.address}\``,
      `- VaultStrategyOpsLib: \`${vaultStrategyOpsLib.address}\``,
      `- VaultBridgeLib: \`${vaultBridgeLib.address}\``,
      `- VaultViewModule: \`${vaultViewModule.address}\``,
      `- VaultOpsModule: \`${vaultOpsModule.address}\``,
      `- Upgrade calldata: \`${upgradeCalldata}\``,
    ],
  });

  console.log(`vaultProxy=${vaultProxy}`);
  console.log(`proxyAdmin=${context.proxyAdmin}`);
  console.log(`proxyAdminOwner=${proxyAdminOwner}`);
  console.log(`signerAddress=${signerAddress}`);
  console.log(`requiresMultisig=${requiresMultisig}`);
  console.log(`vaultStrategyOpsLib=${vaultStrategyOpsLib.address}`);
  console.log(`vaultBridgeLib=${vaultBridgeLib.address}`);
  console.log(`vaultViewModule=${vaultViewModule.address}`);
  console.log(`vaultOpsModule=${vaultOpsModule.address}`);
  console.log(`vaultImplementation=${vaultImplementation.address}`);
  console.log(`upgradeCallData=${upgradeCallData}`);
  console.log(`upgradeCalldata=${upgradeCalldata}`);
  console.log(`recordPath=${prepared.recordPath}`);
  console.log(`recordMode=${prepared.mode}`);

  if (prepared.mode === "prepare") {
    return;
  }

  const { receipt, txHash } = await executeProxyUpgrade({
    implementation: vaultImplementation.address,
    proxy: vaultProxy,
    proxyAdmin: context.proxyAdmin,
    publicClient,
    upgradeCallData,
    walletClient,
  });
  await finalizeDirectUpgrade({
    receipt,
    recordDir: prepared.recordDir,
    txHash,
  });

  console.log(`upgradeTxHash=${txHash}`);
  console.log(`upgradeBlockNumber=${receipt.blockNumber}`);
  console.log(`upgradeStatus=${receipt.status}`);
};

export default action;
