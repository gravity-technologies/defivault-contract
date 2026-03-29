import type { NewTaskActionFunction } from "hardhat/types/tasks";

import {
  encodeSetYieldRecipient,
  getClients,
  readModuleParams,
  requireAddress,
  requireBytes32,
  resolveParametersPath,
  timelockAbi,
  ZERO_BYTES32,
} from "../utils/one-off-ops.js";

type YieldRecipientExecuteUpdateTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<
  YieldRecipientExecuteUpdateTaskArgs
> = async ({ parameters }, hre) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(
    filePath,
    "YieldRecipientExecuteUpdateModule",
  );
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
  const timelock = requireAddress(
    params,
    "yieldRecipientTimelockController",
    filePath,
  );
  const newYieldRecipient = requireAddress(
    params,
    "newYieldRecipient",
    filePath,
  );
  const predecessor =
    params.predecessor === undefined
      ? ZERO_BYTES32
      : requireBytes32(params, "predecessor", filePath);
  const salt =
    params.salt === undefined
      ? ZERO_BYTES32
      : requireBytes32(params, "salt", filePath);
  const { publicClient, walletClient } = await getClients(hre);

  const hash = await walletClient.writeContract({
    address: timelock,
    abi: timelockAbi,
    functionName: "execute",
    args: [
      vaultProxy,
      0n,
      encodeSetYieldRecipient(newYieldRecipient),
      predecessor,
      salt,
    ],
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log(`txHash=${hash}`);
  console.log(`blockNumber=${receipt.blockNumber}`);
  console.log(`status=${receipt.status}`);
};

export default action;
