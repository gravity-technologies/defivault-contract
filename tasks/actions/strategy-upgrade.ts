import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress, type Hex } from "viem";

import {
  getClients,
  readModuleParams,
  requireAddress,
  requireHexData,
  requireString,
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

type StrategyUpgradeTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<StrategyUpgradeTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "StrategyUpgradeModule");
  const proxyAdmin = requireAddress(params, "proxyAdmin", filePath);
  const strategyProxy = requireAddress(params, "strategyProxy", filePath);
  const upgradeCallData: Hex =
    params.upgradeCallData === undefined
      ? ("0x" as Hex)
      : requireHexData(params, "upgradeCallData", filePath);
  const strategyKey =
    typeof params.strategyKey === "string" && params.strategyKey.length > 0
      ? requireString(params, "strategyKey", filePath)
      : "primary";
  const { viem, publicClient, walletClient } = await getClients(hre);
  const signerAddress = getAddress(walletClient.account.address);
  const context = await resolveProxyUpgradeContext({
    filePath,
    hre,
    proxy: strategyProxy,
    proxyAdmin,
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
  const strategyImplementation = await viem.deployContract(
    "AaveV3Strategy",
    [],
    {
      client,
    },
  );
  const upgradeCalldata = encodeProxyUpgradeCalldata({
    implementation: strategyImplementation.address,
    proxy: strategyProxy,
    upgradeCallData,
  });
  const prepared = createUpgradeRecord({
    callData: upgradeCalldata,
    chainId: context.chainId,
    environment: context.environment,
    filePath,
    implementation: strategyImplementation.address,
    kind: "strategy-upgrade",
    longLivedAuthority: context.longLivedAuthority,
    network: context.network,
    proxy: strategyProxy,
    proxyAdmin: context.proxyAdmin,
    proxyAdminOwner: getAddress(proxyAdminOwner),
    repoRoot: context.repoRoot,
    resolvedInputs: {
      proxyAdmin,
      strategyKey,
      strategyProxy,
      upgradeCallData,
    },
    signer: signerAddress,
    summary: [
      "# Strategy upgrade",
      "",
      `- Strategy key: \`${strategyKey}\``,
      `- Strategy proxy: \`${strategyProxy}\``,
      `- ProxyAdmin: \`${context.proxyAdmin}\``,
      `- ProxyAdmin owner: \`${proxyAdminOwner}\``,
      `- Signer: \`${signerAddress}\``,
      `- Strategy implementation: \`${strategyImplementation.address}\``,
      `- Upgrade calldata: \`${upgradeCalldata}\``,
    ],
  });

  console.log(`strategyKey=${strategyKey}`);
  console.log(`strategyProxy=${strategyProxy}`);
  console.log(`proxyAdmin=${context.proxyAdmin}`);
  console.log(`proxyAdminOwner=${proxyAdminOwner}`);
  console.log(`signerAddress=${signerAddress}`);
  console.log(`strategyImplementation=${strategyImplementation.address}`);
  console.log(`upgradeCallData=${upgradeCallData}`);
  console.log(`upgradeCalldata=${upgradeCalldata}`);
  console.log(`recordPath=${prepared.recordPath}`);
  console.log(`recordMode=${prepared.mode}`);

  if (prepared.mode === "prepare") {
    return;
  }

  const { receipt, txHash } = await executeProxyUpgrade({
    implementation: strategyImplementation.address,
    proxy: strategyProxy,
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
