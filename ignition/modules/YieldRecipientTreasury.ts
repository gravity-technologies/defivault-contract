import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * YieldRecipientTreasuryModule
 *
 * Purpose:
 * - Deploy a treasury contract intended to be configured as the vault `yieldRecipient`.
 * - Optionally seed reimbursement policy for strategy/token pairs.
 *
 * Parameters (YieldRecipientTreasuryModule.*):
 * - owner: treasury owner that controls authorization and withdrawals.
 * - reimbursementConfigs: optional list of reimbursement rules to seed at deployment.
 *   Each config object must contain `strategy`, `token`, `enabled`, and `remainingBudget`.
 */
export default buildModule("YieldRecipientTreasuryModule", (m: any) => {
  const owner = m.getParameter("owner");
  const reimbursementConfigs = m.getParameter(
    "reimbursementConfigs",
    [] as Array<{
      strategy: string;
      token: string;
      enabled?: boolean;
      remainingBudget?: bigint;
    }>,
  ) as unknown as Array<{
    strategy: string;
    token: string;
    enabled?: boolean;
    remainingBudget?: bigint;
  }>;

  const treasury = m.contract("YieldRecipientTreasury", [owner]);

  for (const config of reimbursementConfigs) {
    m.call(treasury, "setReimbursementConfig", [
      config.strategy,
      config.token,
      config.enabled === false ? 0n : (config.remainingBudget ?? 0n),
    ]);
  }

  return { treasury };
});
