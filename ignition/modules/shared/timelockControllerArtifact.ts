import { createRequire } from "node:module";

import type { Artifact } from "@nomicfoundation/ignition-core";

const require = createRequire(import.meta.url);

export const timelockControllerArtifact =
  require("@openzeppelin/contracts/build/contracts/TimelockController.json") as Artifact;
