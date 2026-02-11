import { createRequire } from "node:module";

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import type { Artifact } from "@nomicfoundation/ignition-core";

const require = createRequire(import.meta.url);
const transparentUpgradeableProxyArtifact =
  require("@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json") as Artifact;

/**
 * StrategyCoreModule
 *
 * Purpose:
 * - Deploy AaveV3Strategy implementation.
 * - Deploy OpenZeppelin TransparentUpgradeableProxy.
 * - Initialize the strategy proxy in constructor calldata.
 *
 * Parameters (StrategyCoreModule.*):
 * - vaultProxy: existing GRVTDeFiVault proxy.
 * - proxyAdminOwner: owner of the strategy proxy's ProxyAdmin.
 * - aavePool: Aave V3 pool address.
 * - underlyingToken: underlying ERC20 token.
 * - aToken: corresponding Aave aToken.
 * - strategyName: metadata label (defaults to AAVE_V3_UNDERLYING).
 */
export default buildModule("StrategyCoreModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const proxyAdminOwner = m.getParameter("proxyAdminOwner");
  const aavePool = m.getParameter("aavePool");
  const underlyingToken = m.getParameter("underlyingToken");
  const aToken = m.getParameter("aToken");
  const strategyName = m.getParameter("strategyName", "AAVE_V3_UNDERLYING");

  const strategyImplementation = m.contract("AaveV3Strategy", [], {
    id: "StrategyImplementation",
  });

  const initializeCalldata = m.encodeFunctionCall(
    strategyImplementation,
    "initialize",
    [vaultProxy, aavePool, underlyingToken, aToken, strategyName],
    { id: "StrategyInitializeCalldata" },
  );

  const strategyProxy = m.contract(
    "TransparentUpgradeableProxy",
    transparentUpgradeableProxyArtifact,
    [strategyImplementation, proxyAdminOwner, initializeCalldata],
    { id: "StrategyProxy" },
  );

  const strategy = m.contractAt("AaveV3Strategy", strategyProxy, {
    id: "Strategy",
  });

  return { strategyImplementation, strategyProxy, strategy };
});
