import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultUpgradeModule
 *
 * Purpose:
 * - Deploy a new GRVTL1TreasuryVault implementation.
 * - Execute ProxyAdmin upgradeAndCall for an existing vault proxy.
 *
 * Parameters (VaultUpgradeModule.*):
 * - proxyAdmin: ProxyAdmin contract address controlling the proxy.
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - upgradeCallData: optional calldata for post-upgrade initialization (defaults to 0x).
 */
export default buildModule("VaultUpgradeModule", (m) => {
  const proxyAdmin = m.getParameter("proxyAdmin");
  const vaultProxy = m.getParameter("vaultProxy");
  const upgradeCallData = m.getParameter("upgradeCallData", "0x");
  const vaultStrategyOpsLib = m.library("VaultStrategyOpsLib", {
    id: "VaultStrategyOpsLibVNext",
  });
  const vaultBridgeLib = m.library("VaultBridgeLib", {
    id: "VaultBridgeLibVNext",
  });

  const vaultImplementation = m.contract("GRVTL1TreasuryVault", [], {
    id: "VaultImplementationVNext",
    libraries: {
      VaultStrategyOpsLib: vaultStrategyOpsLib,
      VaultBridgeLib: vaultBridgeLib,
    },
  });
  const proxyAdminContract = m.contractAt("IProxyAdmin", proxyAdmin, {
    id: "ProxyAdmin",
  });
  m.call(
    proxyAdminContract,
    "upgradeAndCall",
    [vaultProxy, vaultImplementation, upgradeCallData],
    {
      id: "UpgradeVaultProxy",
    },
  );
  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "VaultAfterUpgrade",
  });

  return { vaultStrategyOpsLib, vaultBridgeLib, vaultImplementation, vault };
});
