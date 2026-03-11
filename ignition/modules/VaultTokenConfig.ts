import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultTokenConfigModule
 *
 * Purpose:
 * - Apply standalone token support configuration on an existing vault.
 *
 * Parameters (VaultTokenConfigModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - vaultToken: token address to configure.
 * - supported: value for setVaultTokenConfig(token, { supported }).
 */
export default buildModule("VaultTokenConfigModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const vaultToken = m.getParameter("vaultToken");
  const supported = m.getParameter("supported", true);

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });
  m.call(vault, "setVaultTokenConfig", [vaultToken, { supported }], {
    id: "SetVaultTokenConfig",
  });

  return { vault };
});
