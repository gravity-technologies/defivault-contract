import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultHarvestYieldModule
 *
 * Purpose:
 * - Attach to existing vault.
 * - Execute a harvest from strategy to treasury.
 *
 * Parameters (VaultHarvestYieldModule.*):
 * - vaultProxy: GRVTDeFiVault proxy address.
 * - token: underlying token address.
 * - strategy: whitelisted (or withdraw-only) strategy address.
 * - amount: requested yield withdrawal from strategy.
 * - minReceived: minimum treasury-side net receipt.
 */
export default buildModule("VaultHarvestYieldModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const strategy = m.getParameter("strategy");
  const amount = m.getParameter("amount");
  const minReceived = m.getParameter("minReceived", 0n);

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);

  m.call(vault, "harvestYieldFromStrategy", [
    token,
    strategy,
    amount,
    minReceived,
  ]);

  return { vault };
});
