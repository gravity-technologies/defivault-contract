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

type EmergencyErc20ToL2TaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<EmergencyErc20ToL2TaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "VaultEmergencyErc20ToL2Module");
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
  const token = requireAddress(params, "token", filePath);
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
    kind: "vault-emergency-erc20-to-l2",
    longLivedAuthority: resolveRecordAuthority({
      currentDeployment: context.currentDeployment,
      vaultProxy,
    }),
    outputs: {
      token,
      vaultProxy,
    },
    resolvedInputs: {
      amount: amount.toString(),
      token,
      vaultProxy,
    },
    signer,
    stepLabel: "Emergency ERC20 bridge to L2",
    summary: [
      "# Emergency ERC20 bridge to L2",
      "",
      `- Vault proxy: \`${vaultProxy}\``,
      `- Token: \`${token}\``,
      `- Amount: \`${amount}\``,
    ],
  });

  const hash = await walletClient.writeContract({
    address: vaultProxy,
    abi: vaultAbi,
    functionName: "emergencyErc20ToL2",
    args: [token, amount],
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
