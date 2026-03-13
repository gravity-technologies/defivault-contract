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
  sharedBridgeAbi,
  ZKSYNC_NATIVE_TOKEN,
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
  const sharedBridge = requireAddress(params, "sharedBridge", filePath);
  const nativeBridgeGatewayProxy = requireAddress(
    params,
    "nativeBridgeGatewayProxy",
    filePath,
  );
  const chainId = requireUint(params, "chainId", filePath);
  const amount = requireUint(params, "amount", filePath);
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

  const claimHash = await walletClient.writeContract({
    address: sharedBridge,
    abi: sharedBridgeAbi,
    functionName: "claimFailedDeposit",
    args: [
      chainId,
      nativeBridgeGatewayProxy,
      ZKSYNC_NATIVE_TOKEN,
      amount,
      bridgeTxHash,
      l2BatchNumber,
      l2MessageIndex,
      l2TxNumberInBatch,
      merkleProof,
    ],
    account: walletClient.account,
  });
  const claimReceipt = await publicClient.waitForTransactionReceipt({
    hash: claimHash,
  });

  const recoverHash = await walletClient.writeContract({
    address: nativeBridgeGatewayProxy,
    abi: nativeBridgeGatewayAbi,
    functionName: "recoverClaimedNativeDeposit",
    args: [bridgeTxHash],
    account: walletClient.account,
  });
  const recoverReceipt = await publicClient.waitForTransactionReceipt({
    hash: recoverHash,
  });

  console.log(`claimTxHash=${claimHash}`);
  console.log(`claimBlockNumber=${claimReceipt.blockNumber}`);
  console.log(`claimStatus=${claimReceipt.status}`);
  console.log(`recoverTxHash=${recoverHash}`);
  console.log(`recoverBlockNumber=${recoverReceipt.blockNumber}`);
  console.log(`recoverStatus=${recoverReceipt.status}`);
};

export default action;
