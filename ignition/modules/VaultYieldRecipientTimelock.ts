import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { timelockControllerArtifact } from "./shared/timelockControllerArtifact.js";

/**
 * VaultYieldRecipientTimelockModule
 *
 * Purpose:
 * - Attach to an existing vault.
 * - Deploy OZ TimelockController from the packaged artifact.
 * - Set vault yield-recipient timelock controller (one-time bootstrap).
 *
 * Parameters (VaultYieldRecipientTimelockModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - minDelay: minimum delay in seconds before scheduled ops can execute.
 * - proposers: addresses allowed to schedule timelock operations.
 * - executors: addresses allowed to execute ready operations.
 * - admin: timelock admin for initial role management.
 */
export default buildModule("VaultYieldRecipientTimelockModule", (m: any) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const minDelay = m.getParameter("minDelay", 86400n);
  const proposers = m.getParameter("proposers");
  const executors = m.getParameter("executors");
  const admin = m.getParameter("admin");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);
  const yieldRecipientTimelockController = m.contract(
    "TimelockController",
    timelockControllerArtifact,
    [minDelay, proposers, executors, admin],
  );

  m.call(vault, "setYieldRecipientTimelockController", [
    yieldRecipientTimelockController,
  ]);

  return { vault, yieldRecipientTimelockController };
});
