import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress } from "viem";

import {
  createDirectOperationRecord,
  finalizeDirectOperationRecord,
  getClients,
  nativeBridgeGatewayAbi,
  readModuleParams,
  requireAddress,
  requireBytes32,
  requireBytes32Array,
  requireUint,
  requireUint16,
  resolveOneOffRecordContext,
  resolveParametersPath,
  resolveRecordAuthority,
} from "../utils/one-off-ops.js";

type ClaimFailedNativeDepositTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<ClaimFailedNativeDepositTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(
    filePath,
    "NativeBridgeGatewayClaimFailedDepositModule",
  );
  const nativeBridgeGatewayProxy = requireAddress(
    params,
    "nativeBridgeGatewayProxy",
    filePath,
  );
  const bridgeTxHash = requireBytes32(params, "bridgeTxHash", filePath);
  const l2BatchNumber = requireUint(params, "l2BatchNumber", filePath);
  const l2MessageIndex = requireUint(params, "l2MessageIndex", filePath);
  const l2TxNumberInBatch = requireUint16(
    params,
    "l2TxNumberInBatch",
    filePath,
  );
  const merkleProof = requireBytes32Array(params, "merkleProof", filePath);
  const { publicClient, walletClient } = await getClients(hre);
  const signer = getAddress(walletClient.account.address);
  const context = await resolveOneOffRecordContext({ filePath, hre });
  const prepared = createDirectOperationRecord({
    context,
    filePath,
    kind: "native-bridge-gateway-claim-failed-deposit",
    longLivedAuthority: resolveRecordAuthority({
      currentDeployment: context.currentDeployment,
      nativeBridgeGatewayProxy,
    }),
    outputs: {
      bridgeTxHash,
      nativeBridgeGatewayProxy,
    },
    resolvedInputs: {
      bridgeTxHash,
      l2BatchNumber: l2BatchNumber.toString(),
      l2MessageIndex: l2MessageIndex.toString(),
      l2TxNumberInBatch,
      merkleProof,
      nativeBridgeGatewayProxy,
    },
    signer,
    stepLabel: "Claim and recover failed native deposit",
    summary: [
      "# Claim and recover failed native deposit",
      "",
      `- Native bridge gateway proxy: \`${nativeBridgeGatewayProxy}\``,
      `- Bridge tx hash: \`${bridgeTxHash}\``,
      `- L2 batch number: \`${l2BatchNumber}\``,
      `- L2 message index: \`${l2MessageIndex}\``,
      `- L2 tx number in batch: \`${l2TxNumberInBatch}\``,
    ],
  });

  const recoveryHash = await walletClient.writeContract({
    address: nativeBridgeGatewayProxy,
    abi: nativeBridgeGatewayAbi,
    functionName: "claimAndRecoverFailedNativeDeposit",
    args: [
      bridgeTxHash,
      l2BatchNumber,
      l2MessageIndex,
      l2TxNumberInBatch,
      merkleProof,
    ],
    account: walletClient.account,
  });
  const recoveryReceipt = await publicClient.waitForTransactionReceipt({
    hash: recoveryHash,
  });
  finalizeDirectOperationRecord({
    receipt: recoveryReceipt,
    recordDir: prepared.recordDir,
    txHash: recoveryHash,
  });

  console.log(`claimAndRecoverTxHash=${recoveryHash}`);
  console.log(`claimAndRecoverBlockNumber=${recoveryReceipt.blockNumber}`);
  console.log(`recordPath=${prepared.recordPath}`);
  console.log(`claimAndRecoverStatus=${recoveryReceipt.status}`);
};

export default action;
