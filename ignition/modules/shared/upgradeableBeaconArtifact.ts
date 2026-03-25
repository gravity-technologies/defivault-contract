import { createRequire } from "node:module";

import type { Artifact } from "@nomicfoundation/ignition-core";

const require = createRequire(import.meta.url);

export const upgradeableBeaconArtifact =
  require("@openzeppelin/contracts/build/contracts/UpgradeableBeacon.json") as Artifact;
