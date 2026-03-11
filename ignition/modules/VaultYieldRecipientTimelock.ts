import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultYieldRecipientTimelockModule
 *
 * Purpose:
 * - Attach to an existing vault.
 * - Deploy an OZ TimelockController.
 * - Set vault yield-recipient timelock (one-time bootstrap).
 *
 * Parameters (VaultYieldRecipientTimelockModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - minDelay: minimum delay in seconds before scheduled ops can execute.
 * - proposers: addresses allowed to schedule timelock operations.
 * - executors: addresses allowed to execute ready operations.
 * - admin: timelock admin for initial role management.
 */
export default buildModule("VaultYieldRecipientTimelockModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const minDelay = m.getParameter("minDelay", 86400n);
  const proposers = m.getParameter("proposers");
  const executors = m.getParameter("executors");
  const admin = m.getParameter("admin");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);
  const yieldRecipientTimelock = m.contract("TimelockController", [
    minDelay,
    proposers,
    executors,
    admin,
  ]);

  m.call(vault, "setYieldRecipientTimelock", [yieldRecipientTimelock]);

  return { vault, yieldRecipientTimelock };
});
