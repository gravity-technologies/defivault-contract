import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultTreasuryTimelockModule
 *
 * Purpose:
 * - Attach to an existing vault.
 * - Deploy an OZ TimelockController.
 * - Set vault treasury timelock (one-time bootstrap).
 *
 * Parameters (VaultTreasuryTimelockModule.*):
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 * - minDelay: minimum delay in seconds before scheduled ops can execute.
 * - proposers: addresses allowed to schedule timelock operations.
 * - executors: addresses allowed to execute ready operations.
 * - admin: timelock admin for initial role management.
 */
export default buildModule("VaultTreasuryTimelockModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const minDelay = m.getParameter("minDelay", 86400n);
  const proposers = m.getParameter("proposers");
  const executors = m.getParameter("executors");
  const admin = m.getParameter("admin");

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);
  const treasuryTimelock = m.contract("TimelockController", [
    minDelay,
    proposers,
    executors,
    admin,
  ]);

  m.call(vault, "setTreasuryTimelock", [treasuryTimelock]);

  return { vault, treasuryTimelock };
});
