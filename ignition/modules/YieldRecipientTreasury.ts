import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * YieldRecipientTreasuryModule
 *
 * Purpose:
 * - Deploy a treasury contract intended to be configured as the vault `yieldRecipient`.
 * - Optionally authorize vaults and seed treasury balances separately after deployment.
 *
 * Parameters (YieldRecipientTreasuryModule.*):
 * - owner: treasury owner that controls authorization and withdrawals.
 */
export default buildModule("YieldRecipientTreasuryModule", (m: any) => {
  const owner = m.getParameter("owner");

  const treasury = m.contract("YieldRecipientTreasury", [owner]);

  return { treasury };
});
