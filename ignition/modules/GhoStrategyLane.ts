import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { encodeFunctionData, parseAbi } from "viem";

import { beaconProxyArtifact } from "./shared/beaconProxyArtifact.js";

const GHO_STRATEGY_INITIALIZE_ABI = parseAbi([
  "function initialize(address vault,address vaultToken,address gho,address stkGho,address gsm,address stkGhoStakingAdapter,address stkGhoRewardsDistributor,string strategyName)",
]);

/**
 * GhoStrategyLaneModule
 *
 * Purpose:
 * - Deploy one BeaconProxy lane attached to an existing GHO strategy family beacon.
 * - Initialize the lane with its vault-token, GSM, staking, and rewards-distributor inputs.
 *
 * Parameters (GhoStrategyLaneModule.*):
 * - strategyBeacon: address of the family's UpgradeableBeacon.
 * - vaultProxy: existing GRVTL1TreasuryVault proxy.
 * - vaultToken: lane input token.
 * - ghoToken: GHO token address.
 * - stkGhoToken: stkGHO token address.
 * - gsmAdapter: GSM router used for vaultToken <-> GHO swaps.
 * - stkGhoStakingAdapter: staking adapter used for GHO <-> stkGHO conversions.
 * - stkGhoRewardsDistributor: Angle distributor used for permissionless rewards claims.
 * - strategyName: metadata label for the lane.
 */
export default buildModule("GhoStrategyLaneModule", (m: any) => {
  const strategyBeacon = m.getParameter("strategyBeacon") as `0x${string}`;
  const vaultProxy = m.getParameter("vaultProxy") as `0x${string}`;
  const vaultToken = m.getParameter("vaultToken") as `0x${string}`;
  const ghoToken = m.getParameter("ghoToken") as `0x${string}`;
  const stkGhoToken = m.getParameter("stkGhoToken") as `0x${string}`;
  const gsmAdapter = m.getParameter("gsmAdapter") as `0x${string}`;
  const stkGhoStakingAdapter = m.getParameter(
    "stkGhoStakingAdapter",
  ) as `0x${string}`;
  const stkGhoRewardsDistributor = m.getParameter(
    "stkGhoRewardsDistributor",
  ) as `0x${string}`;
  const strategyName = m.getParameter("strategyName", "GSM_STKGHO") as string;

  const initializeCalldata = encodeFunctionData({
    abi: GHO_STRATEGY_INITIALIZE_ABI,
    functionName: "initialize",
    args: [
      vaultProxy,
      vaultToken,
      ghoToken,
      stkGhoToken,
      gsmAdapter,
      stkGhoStakingAdapter,
      stkGhoRewardsDistributor,
      strategyName,
    ],
  });

  const strategyProxy = m.contract(
    "BeaconProxy",
    beaconProxyArtifact,
    [strategyBeacon, initializeCalldata],
    { id: "GhoStrategyProxy" },
  );

  const strategy = m.contractAt("GsmStkGhoStrategy", strategyProxy, {
    id: "Strategy",
  });

  return { strategy, strategyProxy };
});
