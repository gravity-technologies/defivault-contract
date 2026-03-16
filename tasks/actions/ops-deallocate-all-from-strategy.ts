import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress } from "viem";

import {
  createDirectOperationRecord,
  finalizeDirectOperationRecord,
  getClients,
  readModuleParams,
  requireAddress,
  resolveOneOffRecordContext,
  resolveParametersPath,
  resolveRecordAuthority,
  vaultAbi,
} from "../utils/one-off-ops.js";

type DeallocateAllFromStrategyTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<DeallocateAllFromStrategyTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(
    filePath,
    "VaultDeallocateAllFromStrategyModule",
  );
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
  const token = requireAddress(params, "token", filePath);
  const strategy = requireAddress(params, "strategy", filePath);
  const { publicClient, walletClient } = await getClients(hre);
  const signer = getAddress(walletClient.account.address);
  const context = await resolveOneOffRecordContext({ filePath, hre });
  const prepared = createDirectOperationRecord({
    context,
    filePath,
    kind: "vault-deallocate-all-from-strategy",
    longLivedAuthority: resolveRecordAuthority({
      currentDeployment: context.currentDeployment,
      vaultProxy,
    }),
    outputs: {
      strategy,
      token,
      vaultProxy,
    },
    resolvedInputs: {
      strategy,
      token,
      vaultProxy,
    },
    signer,
    stepLabel: "Deallocate all vault token from strategy",
    summary: [
      "# Deallocate all vault token from strategy",
      "",
      `- Vault proxy: \`${vaultProxy}\``,
      `- Token: \`${token}\``,
      `- Strategy: \`${strategy}\``,
    ],
  });

  const hash = await walletClient.writeContract({
    address: vaultProxy,
    abi: vaultAbi,
    functionName: "deallocateAllVaultTokenFromStrategy",
    args: [token, strategy],
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  finalizeDirectOperationRecord({
    receipt,
    recordDir: prepared.recordDir,
    txHash: hash,
  });

  console.log(`txHash=${hash}`);
  console.log(`blockNumber=${receipt.blockNumber}`);
  console.log(`recordPath=${prepared.recordPath}`);
  console.log(`status=${receipt.status}`);
};

export default action;
