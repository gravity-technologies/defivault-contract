import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

import { upgradeableBeaconArtifact } from "./shared/upgradeableBeaconArtifact.js";

/**
 * GhoStrategyFamilyModule
 *
 * Purpose:
 * - Deploy the shared GsmStkGhoStrategy implementation for a family of lanes.
 * - Deploy an UpgradeableBeacon owned by the configured beacon owner.
 *
 * Parameters (GhoStrategyFamilyModule.*):
 * - beaconOwner: owner of the strategy family's UpgradeableBeacon.
 */
export default buildModule("GhoStrategyFamilyModule", (m: any) => {
  const beaconOwner = m.getParameter("beaconOwner");

  const strategyImplementation = m.contract("GsmStkGhoStrategy", [], {
    id: "GhoStrategyImplementation",
  });

  const strategyBeacon = m.contract(
    "UpgradeableBeacon",
    upgradeableBeaconArtifact,
    [strategyImplementation, beaconOwner],
    { id: "GhoStrategyBeacon" },
  );

  return { strategyBeacon, strategyImplementation };
});
