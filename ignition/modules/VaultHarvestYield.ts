import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultHarvestYieldModule
 *
 * Purpose:
 * - Attach to existing vault.
 * - Execute a harvest from strategy to yield recipient.
 *
 * Parameters (VaultHarvestYieldModule.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - token: canonical vault token key (ERC20) used for strategy-domain accounting.
 *   This is not a boundary-intent sentinel input and must not be `address(0)`.
 *   For wrapped-native vault-token harvest, pass wrapped-native token address (not `address(0)`).
 * - strategy: whitelisted (or withdraw-only) strategy address.
 * - amount: requested yield withdrawal from strategy.
 * - minReceived: required minimum yield-recipient-side net receipt (no default).
 *   For wrapped-native vault-token harvest this applies to yield-recipient native ETH delta.
 */
export default buildModule("VaultHarvestYieldModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const strategy = m.getParameter("strategy");
  const amount = m.getParameter("amount");
  const minReceived = m.getParameter("minReceived");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);

  m.call(vault, "harvestYieldFromStrategy", [
    token,
    strategy,
    amount,
    minReceived,
  ]);

  return { vault };
});
