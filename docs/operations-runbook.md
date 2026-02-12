# GRVT L1 DeFi Vault Operations Runbook

## Purpose

This runbook defines how to safely operate the L1 vault stack in production:

- `GRVTDeFiVault` (L1 treasury vault)
- `AaveV3Strategy` (yield strategy)
- `ZkSyncNativeBridgeAdapter` (L1 -> L2 bridge adapter)

It is written for low-context operators and incident responders.

## Operational Policy Matrix

| Function | Allowed caller(s) | Blocked by `pause()` | Requires `token.supported == true` |
|---|---|---|---|
| `allocateToStrategy` | `ALLOCATOR_ROLE` | Yes | Yes |
| `deallocateFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE` | No | No |
| `deallocateAllFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE` | No | No |
| `rebalanceToL2` | `REBALANCER_ROLE` | Yes | Yes |
| `emergencySendToL2` | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No | No |

Important emergency semantics:

- `emergencySendToL2` intentionally bypasses normal `rebalanceMaxPerTx` and `rebalanceMinDelay` controls.
- Use emergency sends only with an incident ticket/reference and explicit operator approval.

## Required Roles and Responsibilities

- `DEFAULT_ADMIN_ROLE` / `VAULT_ADMIN_ROLE`: governance, config changes, role grants, emergency break-glass on defensive exits.
- `ALLOCATOR_ROLE`: normal strategy allocation/deallocation operations.
- `REBALANCER_ROLE`: normal L1 -> L2 top-ups.
- `PAUSER_ROLE`: pause/unpause risk-on flows.

## Preconditions

- Contracts are deployed behind transparent proxies.
- Privileged roles are held by multisig-managed addresses.
- Monitoring covers:
  - role grants/revocations
  - bridge adapter and L2 recipient updates
  - pause/unpause events
  - allocation/deallocation/rebalance/emergency events
  - skipped strategy and mismatch telemetry events

## Deployment Checklist

1. Validate deployment inputs and environment variables:
- `DEPLOY_ADMIN`
- `L2_EXCHANGE_RECIPIENT`
- `CUSTODY_ADDRESS`
- `AAVE_POOL`
- `UNDERLYING_TOKEN`
- `A_TOKEN`
- optional: `TRUSTED_INBOUND_CALLER`
- optional: `STRATEGY_NAME`

2. Deploy stack:

```bash
DEPLOY_ADMIN=<addr> \
L2_EXCHANGE_RECIPIENT=<addr> \
CUSTODY_ADDRESS=<addr> \
AAVE_POOL=<addr> \
UNDERLYING_TOKEN=<addr> \
A_TOKEN=<addr> \
npx hardhat run scripts/deploy/deploy-vault-stack.ts --network <network>
```

3. Record and verify:
- proxy addresses (vault, strategy, adapter)
- implementation addresses
- initializer parameters

4. Bootstrap runtime roles/config:

```bash
VAULT_PROXY=<addr> \
ALLOCATOR_ADDRESSES=<addr1,addr2> \
REBALANCER_ADDRESSES=<addr1,addr2> \
PAUSER_ADDRESSES=<addr1,addr2> \
BRIDGE_ADAPTER=<optional-addr> \
L2_EXCHANGE_RECIPIENT=<optional-addr> \
npx hardhat run scripts/roles/bootstrap-vault-roles.ts --network <network>
```

5. Governance setup:
- set per-token `TokenConfig`
- whitelist strategies with cap/tag
- confirm intended recipient and adapter

6. Post-deploy smoke checks:
- `paused == false`
- expected role holders for all role types
- token support/cap/reserve values
- strategy whitelist state
- one minimal rebalance simulation on non-production env

## Normal Operations

### Strategy capital management

- Allocate: `allocateToStrategy(token, strategy, amount, data)`
- Partial deallocate: `deallocateFromStrategy(token, strategy, amount, data)`
- Full deallocate: `deallocateAllFromStrategy(token, strategy, data)`

Operator rules:

- Never allocate unless token is supported and strategy is currently whitelisted.
- Keep `idleReserve` sufficient for expected near-term L1 liquidity needs.
- Review `totalAssetsStatus(token)`; non-zero `skippedStrategies` indicates degraded accounting visibility.

### L1 -> L2 top-up

- Use `rebalanceToL2(token, amount, l2TxGasLimit, l2TxGasPerPubdataByte, refundRecipient)`.
- Provide bridge fee as `msg.value`.
- Expect enforcement of `rebalanceMaxPerTx`, `rebalanceMinDelay`, and available idle after reserve.

## Incident Response Playbooks

### A) Market/protocol stress requiring defensive exits

1. Call `pause()`.
2. Stop all normal allocations/rebalances.
3. Pull funds from strategies via `deallocateFromStrategy` or `deallocateAllFromStrategy`.
4. If L2 urgently needs liquidity, call `emergencySendToL2(...)` with incident reference logged.
5. Reconcile balances after each emergency transaction.

### B) Token de-support during incident

1. Set token `supported = false` to block new risk-taking.
2. Continue defensive exits:
- `deallocateFromStrategy`
- `deallocateAllFromStrategy`
- `emergencySendToL2`
3. Do not re-enable until incident root cause is understood.

### C) Suspected role compromise

1. Pause vault immediately.
2. Revoke compromised role memberships.
3. Rotate keys and re-grant least-privilege roles.
4. Review role/config/fund-movement events before unpause.

### D) Bridge adapter or recipient misconfiguration

1. Pause vault.
2. Update vault pointers with admin calls:
- `setBridgeAdapter(adapter)`
- `setL2ExchangeRecipient(recipient)`
3. If adapter internals need rotation, execute adapter timelock flow (`propose*` -> wait -> `apply*`).
4. Run a minimal validation rebalance in non-production, then unpause production.

## Emergency Send Checklist

Before each `emergencySendToL2` call:

1. Confirm incident ticket/reference exists.
2. Confirm caller is `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE`.
3. Confirm token and amount required by exchange operations.
4. Set explicit `refundRecipient` and bridge gas params.
5. Confirm enough ETH is provided as `msg.value` for bridge execution.
6. Record emitted `EmergencyToL2` event and bridge tx hash.

After call:

1. Check vault idle balance and strategy balances.
2. Confirm expected transfer execution in bridge/custody monitoring.
3. Document outcome and remaining shortfall (if any).

## Native ETH Handling

- Vault accepts native ETH refunds via `receive()`.
- Sweep only with `sweepNative(to, amount)` by `VAULT_ADMIN_ROLE`.
- Treat all sweeps as privileged financial operations and record rationale.

## Validation and Test Commands

Run before production changes:

```bash
npx hardhat compile --force --no-tests
npm run format:sol:check
npm run test:all
```

Fork integration tests (optional but recommended for adapter/strategy realism):

```bash
MAINNET_RPC_URL=<rpc-url> npm run test:fork
```

Optional pinned fork block for reproducibility:

```bash
MAINNET_RPC_URL=<rpc-url> MAINNET_FORK_BLOCK=22000000 npm run test:fork
```

Fork tests currently validate:

- `AaveV3Strategy` against real mainnet Aave pool/USDT/aUSDT behavior.
- Vault defensive-exit semantics on forked state with real token behavior.

## Post-Incident Recovery

1. Reconcile `idleAssets + strategy assets` against expected accounting.
2. Confirm L2 liquidity and bridge settlement completion.
3. Verify role and config state returned to baseline.
4. Produce postmortem with timeline, root cause, blast radius, and control updates.
5. Update this runbook and alerting thresholds if any gap was found.
