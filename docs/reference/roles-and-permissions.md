# Roles and Permissions

## Metadata

- Audience: operators, contributors, reviewers
- Purpose: compact reference for role hierarchy and operational gating
- Canonical for: role ownership, pause/support behavior, fund-moving policy matrix

## Role Hierarchy

- `DEFAULT_ADMIN_ROLE`: administers `VAULT_ADMIN_ROLE`
- `VAULT_ADMIN_ROLE`: administers `REBALANCER_ROLE`, `ALLOCATOR_ROLE`, `YIELD_HARVESTER_ROLE`, and `PAUSER_ROLE`
- `REBALANCER_ROLE`: executes normal L1 -> L2 top-ups
- `ALLOCATOR_ROLE`: allocates and deallocates strategy positions
- `YIELD_HARVESTER_ROLE`: harvests strategy yield
- `PAUSER_ROLE`: pauses allocations, harvests, and normal L1 -> L2 rebalances

Initialization grants the admin address:

- `DEFAULT_ADMIN_ROLE`
- `VAULT_ADMIN_ROLE`
- `PAUSER_ROLE`

Operational roles must be granted separately.

## Policy Matrix

| Function                                     | Allowed caller(s)                            | Blocked by `pause()` | Requires `vaultToken.supported == true` |
| -------------------------------------------- | -------------------------------------------- | -------------------- | --------------------------------------- |
| `setStrategyPolicyConfig`                    | `VAULT_ADMIN_ROLE`                           | No                   | No                                      |
| `allocateVaultTokenToStrategy`               | `ALLOCATOR_ROLE`                             | Yes                  | Yes                                     |
| `deallocateVaultTokenFromStrategy`           | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`       | No                   | No                                      |
| `deallocateAllVaultTokenFromStrategy`        | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`       | No                   | No                                      |
| `harvestYieldFromStrategy`                   | `YIELD_HARVESTER_ROLE` or `VAULT_ADMIN_ROLE` | Yes                  | No                                      |
| `rebalanceNativeToL2` / `rebalanceErc20ToL2` | `REBALANCER_ROLE`                            | Yes                  | Yes                                     |
| `pause`                                      | `PAUSER_ROLE` or `VAULT_ADMIN_ROLE`          | N/A                  | N/A                                     |
| `unpause`                                    | `VAULT_ADMIN_ROLE`                           | N/A                  | N/A                                     |

## Operational Notes

- Pause blocks allocations, harvests, and normal L1 -> L2 rebalances, not defensive exits.
- Incident-time liquidity restoration is explicit: deallocate chosen lanes, then unpause and run the normal bridge path.
- For V2 lanes, normal `deallocate*` calls recover tracked principal only. Residual value stays on the harvest path.
- A strategy can be de-whitelisted but remain `active`, which keeps it withdrawable and reportable.
- Harvest uses the ERC20 vault-token key. `address(0)` is not a strategy token input.
- Native bridge intent uses explicit native methods. Wrapped-native must not be routed through the ERC20 bridge path.

## Code Surfaces

- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
- [../../contracts/vault/GRVTL1TreasuryVault.sol](../../contracts/vault/GRVTL1TreasuryVault.sol)
