import type { NewTaskActionFunction } from "hardhat/types/tasks";

import {
  getClients,
  nativeBridgeGatewayAbi,
  readModuleParams,
  requireAddress,
  requireBytes32,
  requireBytes32Array,
  requireUint,
  requireUint16,
  resolveParametersPath,
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

  console.log(`claimAndRecoverTxHash=${recoveryHash}`);
  console.log(`claimAndRecoverBlockNumber=${recoveryReceipt.blockNumber}`);
  console.log(`claimAndRecoverStatus=${recoveryReceipt.status}`);
};

export default action;
