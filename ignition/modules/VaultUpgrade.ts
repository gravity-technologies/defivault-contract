import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultUpgradeModule
 *
 * Purpose:
 * - Deploy a new GRVTDeFiVault implementation.
 * - Execute ProxyAdmin upgradeAndCall for an existing vault proxy.
 *
 * Parameters (VaultUpgradeModule.*):
 * - proxyAdmin: ProxyAdmin contract address controlling the proxy.
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 * - upgradeCallData: optional calldata for post-upgrade initialization (defaults to 0x).
 */
export default buildModule("VaultUpgradeModule", (m) => {
  const proxyAdmin = m.getParameter("proxyAdmin");
  const vaultProxy = m.getParameter("vaultProxy");
  const upgradeCallData = m.getParameter("upgradeCallData", "0x");

  const vaultImplementation = m.contract("GRVTDeFiVault", [], {
    id: "VaultImplementationVNext",
  });
  const proxyAdminContract = m.contractAt("IProxyAdmin", proxyAdmin, {
    id: "ProxyAdmin",
  });
  m.call(proxyAdminContract, "upgradeAndCall", [vaultProxy, vaultImplementation, upgradeCallData], {
    id: "UpgradeVaultProxy",
  });
  const vault = m.contractAt("GRVTDeFiVault", vaultProxy, {
    id: "VaultAfterUpgrade",
  });

  return { vaultImplementation, vault };
});
