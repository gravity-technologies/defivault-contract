import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { getAddress } from "viem";

import {
  createDirectOperationRecord,
  finalizeDirectOperationRecord,
  getClients,
  parseBigintLike,
  readModuleParams,
  requireAddress,
  requireBoolean,
  resolveOneOffRecordContext,
  resolveParametersPath,
} from "../utils/one-off-ops.js";
import { fetchMerklRewardClaim } from "../utils/merkl-rewards.js";

type ClaimGhoRewardsTaskArgs = {
  parameters?: string;
};

const action: NewTaskActionFunction<ClaimGhoRewardsTaskArgs> = async (
  { parameters },
  hre,
) => {
  const filePath = resolveParametersPath(parameters);
  const params = readModuleParams(filePath, "GhoClaimRewardsModule");
  const strategyAddress = requireAddress(params, "strategy", filePath);
  const apiBase =
    typeof params.apiBase === "string" && params.apiBase.length > 0
      ? params.apiBase
      : undefined;
  const minClaimDelta =
    params.minClaimDelta === undefined
      ? 0n
      : parseBigintLike(params.minClaimDelta, "minClaimDelta", filePath);
  const dryRun =
    params.dryRun === undefined
      ? false
      : requireBoolean(params, "dryRun", filePath);

  const { viem, publicClient, walletClient } = await getClients(hre);
  const strategy = await viem.getContractAt(
    "GsmStkGhoStrategy",
    strategyAddress,
  );
  const rewardToken = getAddress((await strategy.read.stkGhoToken()) as string);
  const stkGhoRewardsDistributor = getAddress(
    (await strategy.read.stkGhoRewardsDistributor()) as string,
  );
  if (
    stkGhoRewardsDistributor === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error(
      `strategy ${strategyAddress} has no rewards distributor set`,
    );
  }
  const claimPlan = await fetchMerklRewardClaim({
    apiBase,
    recipient: strategyAddress,
    rewardToken,
    minClaimDelta,
  });

  if (claimPlan === null) {
    console.log(
      `No claimable stkGHO rewards for strategy=${strategyAddress} token=${rewardToken}`,
    );
    return;
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          apiUrl: claimPlan.apiUrl,
          claimableDelta: claimPlan.claimableDelta.toString(),
          claimedAmount: claimPlan.claimedAmount.toString(),
          cumulativeAmount: claimPlan.cumulativeAmount.toString(),
          proofs: claimPlan.proofs.length,
          recipient: claimPlan.recipient,
          rewardToken: claimPlan.rewardToken,
          stkGhoRewardsDistributor,
          strategy: strategyAddress,
        },
        null,
        2,
      ),
    );
    return;
  }

  const signer = getAddress(walletClient.account.address);
  const context = await resolveOneOffRecordContext({ filePath, hre });
  const prepared = createDirectOperationRecord({
    context,
    filePath,
    kind: "gho-claim-rewards",
    outputs: {
      claimableDelta: claimPlan.claimableDelta.toString(),
      claimedAmount: claimPlan.claimedAmount.toString(),
      cumulativeAmount: claimPlan.cumulativeAmount.toString(),
      apiUrl: claimPlan.apiUrl,
      proofCount: claimPlan.proofs.length,
      rewardToken,
      stkGhoRewardsDistributor,
      strategy: strategyAddress,
    },
    resolvedInputs: {
      apiBase: apiBase ?? "https://api.merkl.xyz",
      claimableDelta: claimPlan.claimableDelta.toString(),
      apiUrl: claimPlan.apiUrl,
      cumulativeAmount: claimPlan.cumulativeAmount.toString(),
      dryRun,
      minClaimDelta: minClaimDelta.toString(),
      proofCount: claimPlan.proofs.length.toString(),
      rewardToken,
      stkGhoRewardsDistributor,
      strategy: strategyAddress,
    },
    signer,
    stepLabel: "Claim stkGHO rewards",
    summary: [
      "# Claim stkGHO rewards",
      "",
      `- Strategy: \`${strategyAddress}\``,
      `- Reward token: \`${rewardToken}\``,
      `- Rewards distributor: \`${stkGhoRewardsDistributor}\``,
      `- Claimable delta: \`${claimPlan.claimableDelta}\``,
    ],
  });

  const hash = await walletClient.writeContract({
    address: strategyAddress,
    abi: strategy.abi,
    functionName: "claimStkGhoRewards",
    args: [claimPlan.cumulativeAmount, claimPlan.proofs],
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
