import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * NativeBridgeGatewayUpgradeModule
 *
 * Purpose:
 * - Deploy a new NativeBridgeGateway implementation.
 * - Execute ProxyAdmin upgradeAndCall for an existing native bridge gateway proxy.
 *
 * Parameters (NativeBridgeGatewayUpgradeModule.*):
 * - proxyAdmin: ProxyAdmin contract address controlling the proxy.
 * - nativeBridgeGatewayProxy: existing NativeBridgeGateway proxy address.
 * - upgradeCallData: optional calldata for post-upgrade initialization (defaults to 0x).
 */
export default buildModule("NativeBridgeGatewayUpgradeModule", (m: any) => {
  const proxyAdmin = m.getParameter("proxyAdmin");
  const nativeBridgeGatewayProxy = m.getParameter("nativeBridgeGatewayProxy");
  const upgradeCallData = m.getParameter("upgradeCallData", "0x");

  const nativeBridgeGatewayImplementation = m.contract(
    "NativeBridgeGateway",
    [],
    {
      id: "NativeBridgeGatewayImplementationVNext",
    },
  );
  const proxyAdminContract = m.contractAt("IProxyAdmin", proxyAdmin, {
    id: "ProxyAdmin",
  });
  m.call(
    proxyAdminContract,
    "upgradeAndCall",
    [
      nativeBridgeGatewayProxy,
      nativeBridgeGatewayImplementation,
      upgradeCallData,
    ],
    {
      id: "UpgradeNativeBridgeGatewayProxy",
    },
  );
  const nativeBridgeGateway = m.contractAt(
    "NativeBridgeGateway",
    nativeBridgeGatewayProxy,
    {
      id: "NativeBridgeGatewayAfterUpgrade",
    },
  );

  return { nativeBridgeGatewayImplementation, nativeBridgeGateway };
});
