import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { encodeFunctionData, type Hex } from "viem";

import {
  getClients,
  readModuleParams,
  requireAddress,
  requireBoolean,
  requireHexData,
  resolveParametersPath,
} from "../utils/one-off-ops.js";
import { proxyAdminAbi, readProxyAdminAddress } from "../utils/proxy-admin.js";

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

  const proxyAdmin = await readProxyAdminAddress(publicClient, vaultProxy);
  const proxyAdminOwner = await publicClient.readContract({
    address: proxyAdmin,
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
  });
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVault",
    [],
    {
      client,
      libraries: {
        VaultStrategyOpsLib: vaultStrategyOpsLib.address,
        VaultBridgeLib: vaultBridgeLib.address,
      },
    },
  );

  const upgradeCalldata = encodeFunctionData({
    abi: proxyAdminAbi,
    functionName: "upgradeAndCall",
    args: [vaultProxy, vaultImplementation.address, upgradeCallData],
  });

  const signerAddress = walletClient.account.address;

  console.log(`vaultProxy=${vaultProxy}`);
  console.log(`proxyAdmin=${proxyAdmin}`);
  console.log(`proxyAdminOwner=${proxyAdminOwner}`);
  console.log(`signerAddress=${signerAddress}`);
  console.log(`requiresMultisig=${requiresMultisig}`);
  console.log(`vaultStrategyOpsLib=${vaultStrategyOpsLib.address}`);
  console.log(`vaultBridgeLib=${vaultBridgeLib.address}`);
  console.log(`vaultImplementation=${vaultImplementation.address}`);
  console.log(`upgradeCallData=${upgradeCallData}`);
  console.log(`upgradeCalldata=${upgradeCalldata}`);

  if (requiresMultisig) {
    return;
  }

  if (signerAddress.toLowerCase() !== proxyAdminOwner.toLowerCase()) {
    throw new Error(
      `wallet signer ${signerAddress} does not control proxy admin ${proxyAdminOwner}`,
    );
  }

  const txHash = await walletClient.writeContract({
    address: proxyAdmin,
    abi: proxyAdminAbi,
    functionName: "upgradeAndCall",
    args: [vaultProxy, vaultImplementation.address, upgradeCallData],
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  console.log(`upgradeTxHash=${txHash}`);
  console.log(`upgradeBlockNumber=${receipt.blockNumber}`);
  console.log(`upgradeStatus=${receipt.status}`);
};

export default action;
