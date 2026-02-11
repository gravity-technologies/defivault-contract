import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultTokenConfigModule
 *
 * Purpose:
 * - Apply standalone token support configuration on an existing vault.
 *
 * Parameters (VaultTokenConfigModule.*):
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 * - token: token address to configure.
 * - supported: value for setTokenConfig(token, { supported }).
 */
export default buildModule("VaultTokenConfigModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const supported = m.getParameter("supported", true);

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy, { id: "Vault" });
  m.call(vault, "setTokenConfig", [token, { supported }], {
    id: "SetTokenConfig",
  });

  return { vault };
});
