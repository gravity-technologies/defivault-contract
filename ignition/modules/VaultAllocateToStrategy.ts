import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultAllocateToStrategyModule
 *
 * Purpose:
 * - Attach to an existing vault proxy.
 * - Allocate one vault-token position into one strategy.
 *
 * Parameters (VaultAllocateToStrategyModule.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - token: canonical vault token key (ERC20) used for strategy-domain accounting.
 * - strategy: whitelisted strategy address to receive the allocation.
 * - amount: requested allocation amount.
 */
export default buildModule("VaultAllocateToStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const strategy = m.getParameter("strategy");
  const amount = m.getParameter("amount");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);

  m.call(vault, "allocateVaultTokenToStrategy", [token, strategy, amount]);

  return { vault };
});
