import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { transparentUpgradeableProxyArtifact } from "./shared/transparentProxyArtifact.js";

/**
 * GhoStrategyCoreModule
 *
 * Purpose:
 * - Deploy GsmStkGhoStrategy implementation.
 * - Deploy OpenZeppelin TransparentUpgradeableProxy.
 * - Initialize the strategy proxy in constructor calldata.
 *
 * Parameters (GhoStrategyCoreModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy.
 * - proxyAdminOwner: owner of the strategy proxy's ProxyAdmin.
 * - vaultToken: input vault token for this lane (for example USDC or USDT).
 * - gho: GHO token address.
 * - stkGho: stkGHO token address.
 * - gsm: GSM router used for vaultToken <-> GHO swaps.
 * - stakingAdapter: staking adapter used for GHO <-> stkGHO conversion.
 * - strategyName: metadata label for the deployment.
 */
export default buildModule("GhoStrategyCoreModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const proxyAdminOwner = m.getParameter("proxyAdminOwner");
  const vaultToken = m.getParameter("vaultToken");
  const gho = m.getParameter("gho");
  const stkGho = m.getParameter("stkGho");
  const gsm = m.getParameter("gsm");
  const stakingAdapter = m.getParameter("stakingAdapter");
  const strategyName = m.getParameter("strategyName", "GSM_STKGHO");

  const strategyImplementation = m.contract("GsmStkGhoStrategy", [], {
    id: "GhoStrategyImplementation",
  });

  const initializeCalldata = m.encodeFunctionCall(
    strategyImplementation,
    "initialize",
    [vaultProxy, vaultToken, gho, stkGho, gsm, stakingAdapter, strategyName],
    { id: "GhoStrategyInitializeCalldata" },
  );

  const strategyProxy = m.contract(
    "TransparentUpgradeableProxy",
    transparentUpgradeableProxyArtifact,
    [strategyImplementation, proxyAdminOwner, initializeCalldata],
    { id: "GhoStrategyProxy" },
  );

  const strategy = m.contractAt("GsmStkGhoStrategy", strategyProxy, {
    id: "GhoStrategy",
  });

  return { strategyImplementation, strategyProxy, strategy };
});
