import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress } from "viem";

import {
  createDirectOperationRecord,
  encodeSetYieldRecipient,
  finalizeDirectOperationRecord,
  getClients,
  readModuleParams,
  requireAddress,
  requireBytes32,
  resolveOneOffRecordContext,
  resolveParametersPath,
  resolveRecordAuthority,
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
  const signer = getAddress(walletClient.account.address);
  const context = await resolveOneOffRecordContext({ filePath, hre });
  const prepared = createDirectOperationRecord({
    context,
    filePath,
    kind: "yield-recipient-execute-update",
    longLivedAuthority: resolveRecordAuthority({
      currentDeployment: context.currentDeployment,
      timelockController: timelock,
    }),
    outputs: {
      timelock,
      vaultProxy,
    },
    resolvedInputs: {
      newYieldRecipient,
      predecessor,
      salt,
      timelock,
      vaultProxy,
    },
    signer,
    stepLabel: "Execute yield recipient update",
    summary: [
      "# Execute yield recipient update",
      "",
      `- Timelock: \`${timelock}\``,
      `- Vault proxy: \`${vaultProxy}\``,
      `- New yield recipient: \`${newYieldRecipient}\``,
      `- Predecessor: \`${predecessor}\``,
      `- Salt: \`${salt}\``,
    ],
  });

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
