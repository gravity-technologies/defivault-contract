import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultPrincipalTokenConfigModule
 *
 * Purpose:
 * - Apply standalone token support configuration on an existing vault.
 *
 * Parameters (VaultPrincipalTokenConfigModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - principalToken: token address to configure.
 * - supported: value for setPrincipalTokenConfig(token, { supported }).
 */
export default buildModule("VaultPrincipalTokenConfigModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const principalToken = m.getParameter("principalToken");
  const supported = m.getParameter("supported", true);

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });
  m.call(vault, "setPrincipalTokenConfig", [principalToken, { supported }], {
    id: "SetPrincipalTokenConfig",
  });

  return { vault };
});
