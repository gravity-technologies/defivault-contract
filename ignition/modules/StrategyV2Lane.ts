import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { encodeFunctionData, parseAbi } from "viem";

import { beaconProxyArtifact } from "./shared/beaconProxyArtifact.js";

const AAVE_V2_INITIALIZE_ABI = parseAbi([
  "function initialize(address vault,address aavePool,address vaultToken,address aToken,string strategyName)",
]);

/**
 * StrategyV2LaneModule
 *
 * Purpose:
 * - Deploy one BeaconProxy lane attached to an existing Aave V3 strategy family beacon.
 * - Initialize the lane with its vault, Aave pool, underlying token, and aToken inputs.
 *
 * Parameters (StrategyV2LaneModule.*):
 * - strategyBeacon: address of the family's UpgradeableBeacon.
 * - vaultProxy: existing GRVTL1TreasuryVault proxy.
 * - aavePool: Aave V3 pool address.
 * - vaultToken: lane input token.
 * - aToken: corresponding Aave aToken.
 * - strategyName: metadata label for the lane.
 */
export default buildModule("StrategyV2LaneModule", (m: any) => {
  const strategyBeacon = m.getParameter("strategyBeacon") as `0x${string}`;
  const vaultProxy = m.getParameter("vaultProxy") as `0x${string}`;
  const aavePool = m.getParameter("aavePool") as `0x${string}`;
  const vaultToken = m.getParameter("vaultToken") as `0x${string}`;
  const aToken = m.getParameter("aToken") as `0x${string}`;
  const strategyName = m.getParameter(
    "strategyName",
    "AAVE_V3_UNDERLYING_V2",
  ) as string;

  const initializeCalldata = encodeFunctionData({
    abi: AAVE_V2_INITIALIZE_ABI,
    functionName: "initialize",
    args: [vaultProxy, aavePool, vaultToken, aToken, strategyName],
  });

  const strategyProxy = m.contract(
    "BeaconProxy",
    beaconProxyArtifact,
    [strategyBeacon, initializeCalldata],
    { id: "StrategyV2Proxy" },
  );

  const strategy = m.contractAt("AaveV3StrategyV2", strategyProxy, {
    id: "Strategy",
  });

  return { strategy, strategyProxy };
});
