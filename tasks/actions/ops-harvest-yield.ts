import type { NewTaskActionFunction } from "hardhat/types/tasks";

import {
  getClients,
  readModuleParams,
  requireAddress,
  requireUint,
  resolveParametersPath,
  vaultAbi,
} from "../utils/one-off-ops.js";

type HarvestYieldTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<HarvestYieldTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "VaultHarvestYieldModule");
  const vaultProxy = requireAddress(params, "vaultProxy", filePath);
  const token = requireAddress(params, "token", filePath);
  const strategy = requireAddress(params, "strategy", filePath);
  const amount = requireUint(params, "amount", filePath);
  const minReceived = requireUint(params, "minReceived", filePath);
  const { publicClient, walletClient } = await getClients(hre);

  const hash = await walletClient.writeContract({
    address: vaultProxy,
    abi: vaultAbi,
    functionName: "harvestYieldFromStrategy",
    args: [token, strategy, amount, minReceived],
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log(`txHash=${hash}`);
  console.log(`blockNumber=${receipt.blockNumber}`);
  console.log(`status=${receipt.status}`);
};

export default action;
