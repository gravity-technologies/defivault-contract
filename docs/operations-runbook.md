# GRVT L1 DeFi Vault Operations Runbook

## Preconditions

- Contracts deployed via transparent proxies.
- Admin is a multisig with defined signer policy.
- Monitoring in place for:
- role grants/revocations
- bridge adapter and L2 recipient updates
- pause/unpause events
- allocate/deallocate/rebalance/emergency events

## Deployment Checklist

1. Validate all environment variables for deployment script.
2. Deploy stack with:
`npx hardhat run scripts/deploy/deploy-vault-stack.ts --network <network>`
3. Record proxy and implementation addresses.
4. Verify contracts on explorer.
5. Bootstrap roles and runtime config with:
`npx hardhat run scripts/roles/bootstrap-vault-roles.ts --network <network>`
6. Configure token support and strategy whitelist from governance account.
7. Run post-deploy smoke checks:
- `paused == false`
- role memberships are correct
- token config and strategy whitelist values are correct
- small rebalance path dry run

## Normal Operations

1. Rebalancer monitors L2 net balance and executes `rebalanceToL2` within configured limits (`rebalanceMaxPerTx`, `rebalanceMinDelay`).
2. Allocator executes `allocateToStrategy` and `deallocateFromStrategy` under treasury policy.
3. Keep enough idle reserve to absorb short-term withdrawal spikes.

## Incident Response

### Scenario: protocol risk or unstable market

1. Pause vault (`pause()`).
2. Stop new allocations/rebalances.
3. Pull strategy liquidity with `deallocateFromStrategy`/`deallocateAllFromStrategy`.
4. If exchange liquidity is constrained, execute `emergencySendToL2` (this path intentionally bypasses `rebalanceMaxPerTx` and `rebalanceMinDelay`).
5. Require an incident ticket/reference before each emergency top-up transaction.
6. Reconcile post-action balances after each emergency top-up.

### Scenario: bridge/custody misconfiguration

1. Pause vault.
2. Correct adapter/recipient config from admin.
3. Run minimal smoke rebalance.
4. Unpause after confirmation.

### Scenario: role compromise suspicion

1. Pause vault immediately.
2. Revoke compromised roles.
3. Rotate keys and re-bootstrap roles.
4. Review logs and balances before resuming.

## Recovery and Postmortem

1. Reconcile L1 idle + strategy assets against expected accounting.
2. Confirm L2 liquidity restoration.
3. Review emergency transaction sizes/timestamps against incident records and justify any outlier sends.
4. Document timeline, root cause, and control improvements.
5. Update runbook and alerting rules.
