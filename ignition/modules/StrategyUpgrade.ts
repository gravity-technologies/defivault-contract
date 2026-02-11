import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * StrategyUpgradeModule
 *
 * Purpose:
 * - Deploy a new AaveV3Strategy implementation.
 * - Execute ProxyAdmin upgradeAndCall for an existing strategy proxy.
 *
 * Parameters (StrategyUpgradeModule.*):
 * - proxyAdmin: ProxyAdmin contract address controlling the proxy.
 * - strategyProxy: existing AaveV3Strategy proxy address.
 * - upgradeCallData: optional calldata for post-upgrade initialization (defaults to 0x).
 */
export default buildModule("StrategyUpgradeModule", (m) => {
  const proxyAdmin = m.getParameter("proxyAdmin");
  const strategyProxy = m.getParameter("strategyProxy");
  const upgradeCallData = m.getParameter("upgradeCallData", "0x");

  const strategyImplementation = m.contract("AaveV3Strategy", [], {
    id: "StrategyImplementationVNext",
  });
  const proxyAdminContract = m.contractAt("IProxyAdmin", proxyAdmin, {
    id: "ProxyAdmin",
  });
  m.call(
    proxyAdminContract,
    "upgradeAndCall",
    [strategyProxy, strategyImplementation, upgradeCallData],
    {
      id: "UpgradeStrategyProxy",
    },
  );
  const strategy = m.contractAt("AaveV3Strategy", strategyProxy, {
    id: "StrategyAfterUpgrade",
  });

  return { strategyImplementation, strategy };
});
