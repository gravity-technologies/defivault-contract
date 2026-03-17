import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultDeallocateFromStrategyModule
 *
 * Purpose:
 * - Attach to an existing vault proxy.
 * - Deallocate part of one vault-token position from one strategy.
 *
 * Parameters (VaultDeallocateFromStrategyModule.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - token: canonical vault token key (ERC20) used for strategy-domain accounting.
 * - strategy: strategy address to unwind from.
 * - amount: requested amount to withdraw.
 */
export default buildModule("VaultDeallocateFromStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const strategy = m.getParameter("strategy");
  const amount = m.getParameter("amount");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);

  m.call(vault, "deallocateVaultTokenFromStrategy", [token, strategy, amount]);

  return { vault };
});
