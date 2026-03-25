import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

import { upgradeableBeaconArtifact } from "./shared/upgradeableBeaconArtifact.js";

/**
 * StrategyV2FamilyModule
 *
 * Purpose:
 * - Deploy the shared AaveV3StrategyV2 implementation for a family of lanes.
 * - Deploy an UpgradeableBeacon owned by the configured beacon owner.
 *
 * Parameters (StrategyV2FamilyModule.*):
 * - beaconOwner: owner of the strategy family's UpgradeableBeacon.
 */
export default buildModule("StrategyV2FamilyModule", (m: any) => {
  const beaconOwner = m.getParameter("beaconOwner");

  const strategyImplementation = m.contract("AaveV3StrategyV2", [], {
    id: "StrategyV2Implementation",
  });

  const strategyBeacon = m.contract(
    "UpgradeableBeacon",
    upgradeableBeaconArtifact,
    [strategyImplementation, beaconOwner],
    { id: "StrategyV2Beacon" },
  );

  return { strategyBeacon, strategyImplementation };
});
