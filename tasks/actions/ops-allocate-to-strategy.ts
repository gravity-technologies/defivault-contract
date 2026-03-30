import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress } from "viem";

import {
  createDirectOperationRecord,
  finalizeDirectOperationRecord,
  getClients,
  readModuleParams,
  requireAddress,
  requireUint,
  resolveOneOffRecordContext,
  resolveParametersPath,
  resolveRecordAuthority,
  vaultAbi,
} from "../utils/one-off-ops.js";

type AllocateToStrategyTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<AllocateToStrategyTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "VaultAllocateToStrategyModule");
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
  const token = requireAddress(params, "token", filePath);
  const strategy = requireAddress(params, "strategy", filePath);
  const amount = requireUint(params, "amount", filePath);
  if (amount === 0n) {
    throw new Error(
      `invalid amount in ${filePath}; expected a positive bigint`,
    );
  }
  const { publicClient, walletClient } = await getClients(hre);
  const signer = getAddress(walletClient.account.address);
  const context = await resolveOneOffRecordContext({ filePath, hre });
  const prepared = createDirectOperationRecord({
    context,
    filePath,
    kind: "vault-allocate-to-strategy",
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
      amount: amount.toString(),
      strategy,
      token,
      vaultProxy,
    },
    signer,
    stepLabel: "Allocate vault token to strategy",
    summary: [
      "# Allocate vault token to strategy",
      "",
      `- Vault proxy: \`${vaultProxy}\``,
      `- Token: \`${token}\``,
      `- Strategy: \`${strategy}\``,
      `- Amount: \`${amount}\``,
    ],
  });

  const hash = await walletClient.writeContract({
    address: vaultProxy,
    abi: vaultAbi,
    functionName: "allocateVaultTokenToStrategy",
    args: [token, strategy, amount],
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
