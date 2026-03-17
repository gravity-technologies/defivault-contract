import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultDeallocateAllFromStrategyModule
 *
 * Purpose:
 * - Attach to an existing vault proxy.
 * - Fully unwind one vault-token position from one strategy.
 *
 * Parameters (VaultDeallocateAllFromStrategyModule.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - token: canonical vault token key (ERC20) used for strategy-domain accounting.
 * - strategy: strategy address to unwind from.
 */
export default buildModule("VaultDeallocateAllFromStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const strategy = m.getParameter("strategy");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);

  m.call(vault, "deallocateAllVaultTokenFromStrategy", [token, strategy]);

  return { vault };
});
