import { createRequire } from "node:module";

import type { Artifact } from "@nomicfoundation/ignition-core";

const require = createRequire(import.meta.url);

export const transparentUpgradeableProxyArtifact =
  require("@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json") as Artifact;
