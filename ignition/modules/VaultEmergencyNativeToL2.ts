import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultEmergencyNativeToL2Module
 *
 * Purpose:
 * - Attach to an existing vault proxy.
 * - Trigger the emergency native-asset bridge path to L2.
 *
 * Parameters (VaultEmergencyNativeToL2Module.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - amount: native amount to bridge through the emergency path.
 *
 * Operational note:
 * - This module does not send `msg.value`; the vault enforces `msg.value == 0`
 *   and funds bridge execution through its configured fee-token flow.
 */
export default buildModule("VaultEmergencyNativeToL2Module", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const amount = m.getParameter("amount");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);

  m.call(vault, "emergencyNativeToL2", [amount]);

  return { vault };
});
