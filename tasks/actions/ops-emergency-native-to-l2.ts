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

type EmergencyNativeToL2TaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<EmergencyNativeToL2TaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "VaultEmergencyNativeToL2Module");
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
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
    kind: "vault-emergency-native-to-l2",
    longLivedAuthority: resolveRecordAuthority({
      currentDeployment: context.currentDeployment,
      vaultProxy,
    }),
    outputs: {
      vaultProxy,
    },
    resolvedInputs: {
      amount: amount.toString(),
      vaultProxy,
    },
    signer,
    stepLabel: "Emergency native bridge to L2",
    summary: [
      "# Emergency native bridge to L2",
      "",
      `- Vault proxy: \`${vaultProxy}\``,
      `- Amount: \`${amount}\``,
    ],
  });

  const hash = await walletClient.writeContract({
    address: vaultProxy,
    abi: vaultAbi,
    functionName: "emergencyNativeToL2",
    args: [amount],
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
