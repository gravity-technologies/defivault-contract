import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress, isHex, type Hex } from "viem";

import { getClients } from "../utils/one-off-ops.js";
import { confirmPreparedUpgrade } from "../utils/proxy-upgrade.js";

type StrategyUpgradeConfirmTaskArgs = {
  record?: string;
  strategyKey?: string;
  txHash?: string;
};

const action: NewTaskActionFunction<StrategyUpgradeConfirmTaskArgs> = async (
  { record, strategyKey, txHash },
  hre,
) => {
  if (record === undefined) {
    throw new Error("missing required --record <record.json|directory>");
  }
  if (txHash === undefined || !isHex(txHash)) {
    throw new Error("missing or invalid --txHash <0x...>");
  }

  const { publicClient, walletClient } = await getClients(hre);
  const chainId = await publicClient.getChainId();
  const signer = getAddress(walletClient.account.address);
  const confirmed = await confirmPreparedUpgrade({
    chainId,
    kind: "strategy-upgrade",
    publicClient,
    recordPathOrDir: record,
    repoRoot: hre.config.paths.root,
    signer,
    strategyKey:
      strategyKey && strategyKey.length > 0 ? strategyKey : undefined,
    txHash: txHash as Hex,
  });

  console.log(`recordPath=${confirmed.recordPath}`);
};

export default action;
