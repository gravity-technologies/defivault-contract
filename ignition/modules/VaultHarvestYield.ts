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
 * - token: canonical principal token key (ERC20) used for strategy-domain accounting.
 *   This is not a boundary-intent sentinel input and must not be `address(0)`.
 *   For wrapped-native principal harvest, pass wrapped-native token address (not `address(0)`).
 * - strategy: whitelisted (or withdraw-only) strategy address.
 * - amount: requested yield withdrawal from strategy.
 * - minReceived: required minimum treasury-side net receipt (no default).
 *   For wrapped-native principal harvest this applies to treasury native ETH delta.
 */
export default buildModule("VaultHarvestYieldModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const strategy = m.getParameter("strategy");
  const amount = m.getParameter("amount");
  const minReceived = m.getParameter("minReceived");

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);

  m.call(vault, "harvestYieldFromStrategy", [
    token,
    strategy,
    amount,
    minReceived,
  ]);

  return { vault };
});
