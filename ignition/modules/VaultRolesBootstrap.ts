import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultRolesBootstrapModule
 *
 * Purpose:
 * - Attach to an existing vault.
 * - Grant ALLOCATOR, REBALANCER, and PAUSER roles.
 *
 * Parameters (VaultRolesBootstrapModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
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

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });

  const allocatorRole = m.staticCall(vault, "ALLOCATOR_ROLE", [], undefined, {
    id: "AllocatorRole",
  });
  const rebalancerRole = m.staticCall(vault, "REBALANCER_ROLE", [], undefined, {
    id: "RebalancerRole",
  });
  const pauserRole = m.staticCall(vault, "PAUSER_ROLE", [], undefined, {
    id: "PauserRole",
  });

  const grantAllocatorRole = m.call(
    vault,
    "grantRole",
    [allocatorRole, allocator],
    {
      id: "GrantAllocatorRole",
    },
  );
  const grantRebalancerRole = m.call(
    vault,
    "grantRole",
    [rebalancerRole, rebalancer],
    {
      id: "GrantRebalancerRole",
      after: [grantAllocatorRole],
    },
  );
  m.call(vault, "grantRole", [pauserRole, pauser], {
    id: "GrantPauserRole",
    after: [grantRebalancerRole],
  });

  return { vault };
});
