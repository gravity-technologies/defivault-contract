import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress, isHex, type Hex } from "viem";

import { getClients } from "../utils/one-off-ops.js";
import { confirmPreparedUpgrade } from "../utils/proxy-upgrade.js";

type VaultUpgradeConfirmTaskArgs = {
  record?: string;
  txHash?: string;
};

const action: NewTaskActionFunction<VaultUpgradeConfirmTaskArgs> = async (
  { record, txHash },
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
    kind: "vault-upgrade",
    publicClient,
    recordPathOrDir: record,
    repoRoot: hre.config.paths.root,
    signer,
    txHash: txHash as Hex,
  });

  console.log(`recordPath=${confirmed.recordPath}`);
};

export default action;
