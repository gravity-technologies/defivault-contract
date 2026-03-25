import { createRequire } from "node:module";

import type { Artifact } from "@nomicfoundation/ignition-core";

const require = createRequire(import.meta.url);

export const beaconProxyArtifact =
  require("@openzeppelin/contracts/build/contracts/BeaconProxy.json") as Artifact;
