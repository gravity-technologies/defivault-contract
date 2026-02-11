import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultRolesBootstrapModule
 *
 * Purpose:
 * - Attach to an existing vault.
 * - Grant ALLOCATOR, REBALANCER, and PAUSER roles.
 *
 * Parameters (VaultRolesBootstrapModule.*):
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 * - allocator: address to grant ALLOCATOR_ROLE.
 * - rebalancer: address to grant REBALANCER_ROLE.
 * - pauser: address to grant PAUSER_ROLE.
 *
 * Notes:
 * - For additional role members, run the module again with a different
 *   deployment id and alternate parameters.
 */
export default buildModule("VaultRolesBootstrapModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const allocator = m.getParameter("allocator");
  const rebalancer = m.getParameter("rebalancer");
  const pauser = m.getParameter("pauser");

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);

  const allocatorRole = m.staticCall(vault, "ALLOCATOR_ROLE");
  const rebalancerRole = m.staticCall(vault, "REBALANCER_ROLE");
  const pauserRole = m.staticCall(vault, "PAUSER_ROLE");

  m.call(vault, "grantRole", [allocatorRole, allocator]);
  m.call(vault, "grantRole", [rebalancerRole, rebalancer]);
  m.call(vault, "grantRole", [pauserRole, pauser]);

  return { vault };
});
