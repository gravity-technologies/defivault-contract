import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultEmergencyErc20ToL2Module
 *
 * Purpose:
 * - Attach to an existing vault proxy.
 * - Trigger the emergency ERC20 bridge path to L2.
 *
 * Parameters (VaultEmergencyErc20ToL2Module.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - token: ERC20 token address to bridge through the emergency path.
 * - amount: ERC20 amount to bridge.
 *
 * Operational note:
 * - This module does not send `msg.value`; the vault enforces `msg.value == 0`
 *   and funds bridge execution through its configured fee-token flow.
 */
export default buildModule("VaultEmergencyErc20ToL2Module", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const token = m.getParameter("token");
  const amount = m.getParameter("amount");

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);

  m.call(vault, "emergencyErc20ToL2", [token, amount]);

  return { vault };
});
