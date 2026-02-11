# GRVT L1 DeFi Vault Operations Runbook

## Purpose

This runbook defines safe production operations for:

- `GRVTDeFiVault` (upgradeable L1 treasury vault)
- `AaveV3Strategy` (vault-controlled yield strategy)

It covers deployment, role/bootstrap operations, normal operations, emergency handling, and audit records.

## Core Operational Semantics

### Policy Matrix

| Function                    | Allowed caller(s)                       | Blocked by `pause()` | Requires `token.supported == true` |
| --------------------------- | --------------------------------------- | -------------------- | ---------------------------------- |
| `allocateToStrategy`        | `ALLOCATOR_ROLE`                        | Yes                  | Yes                                |
| `deallocateFromStrategy`    | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No                   | No                                 |
| `deallocateAllFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No                   | No                                 |
| `rebalanceToL2`             | `REBALANCER_ROLE`                       | Yes                  | Yes                                |
| `emergencySendToL2`         | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No                   | No                                 |

### Bridge Fee Model

- `rebalanceToL2` and `emergencySendToL2` require `msg.value == 0`.
- Vault mints base token and submits a BridgeHub two-bridges request.

### Emergency Behavior

- `emergencySendToL2` can be called while paused.
- If idle balance is insufficient, it performs best-effort strategy unwinds (bounded by max strategy count).
- If funds are still insufficient after unwind attempts, call reverts.

## Roles and Responsibilities

- `DEFAULT_ADMIN_ROLE` / `VAULT_ADMIN_ROLE`: governance, config, role admin, emergency actions.
- `ALLOCATOR_ROLE`: strategy allocation/deallocation.
- `REBALANCER_ROLE`: normal L1 -> L2 top-ups.
- `PAUSER_ROLE`: pause/unpause risk-on operations.

## Deployment State and Audit Trail

Deployments are managed with Hardhat Ignition.

- Source of truth: Ignition deployment state under `ignition/deployments/`.
- No custom deployment JSON artifacts are produced by project scripts.
- Keep parameter files and deployment IDs in change records for reproducibility.

Useful commands:

```bash
npx hardhat ignition deployments --network <network>
npx hardhat ignition status <deployment-id> --network <network>
npx hardhat ignition transactions <deployment-id> --network <network>
```

## Environment and Parameters

Use `.env` only for network credentials (see `.env.example`):

- `SEPOLIA_RPC_URL`
- `SEPOLIA_PRIVATE_KEY`

Keep deployment inputs in versioned Ignition parameter files:

```text
ignition/parameters/<environment>/*.json5
```

## Deployment Workflow

### Step 1: Deploy Vault Core

Prepare:

- `ignition/parameters/<env>/vault-core.json5` with:
  - `deployAdmin`
  - `bridgeHub`
  - `baseToken`
  - `l2ChainId`
  - `l2ExchangeRecipient`

Command:

```bash
npm run deploy:vault -- \
  --network <network> \
  --parameters ignition/parameters/<env>/vault-core.json5
```

### Step 2: Onboard Token + Aave Strategy

Prepare:

- `ignition/parameters/<env>/token-strategy.json5` with:
  - `vaultProxy`
  - `proxyAdmin`
  - `aavePool`
  - `underlyingToken`
  - `aToken`
  - `strategyName`
  - `tokenSupported`
  - `strategyCap`

Command:

```bash
npm run deploy:token-strategy -- \
  --network <network> \
  --parameters ignition/parameters/<env>/token-strategy.json5
```

### Step 3: Bootstrap Initial Roles

Prepare:

- `ignition/parameters/<env>/roles-bootstrap.json5` with:
  - `vaultProxy`
  - `allocator`
  - `rebalancer`
  - `pauser`

Command:

```bash
npm run roles:bootstrap -- \
  --network <network> \
  --parameters ignition/parameters/<env>/roles-bootstrap.json5
```

For additional role members, run the roles module again with a new deployment ID and updated parameter file.

## Post-Deploy Verification Checklist

1. Confirm `paused() == false`.
2. Confirm expected role holders for all roles.
3. Confirm `bridgeHub/baseToken/l2ChainId/l2ExchangeRecipient` match intended values.
4. Confirm token support and strategy whitelist state.
5. Confirm Ignition deployment state and deployment ID are attached to deployment record.

## Normal Operations

### Strategy Capital Management

- Allocate: `allocateToStrategy(token, strategy, amount)`
- Partial deallocate: `deallocateFromStrategy(token, strategy, amount)`
- Full deallocate: `deallocateAllFromStrategy(token, strategy)`

Operator rules:

- Do not allocate unless token is supported and strategy is whitelisted.
- Use `totalAssetsStatus(token)`; non-zero `skippedStrategies` indicates degraded reporting.

### L1 -> L2 Top-Up

Use:

- `rebalanceToL2(token, amount, l2TxGasLimit, l2TxGasPerPubdataByte, refundRecipient)`

Checks:

- caller has `REBALANCER_ROLE`
- vault not paused
- token supported
- `msg.value == 0`
- amount within current `availableForRebalance(token)`

## Incident Response Playbooks

### A) Market/protocol stress

1. `pause()`.
2. Stop risk-on operations (`allocateToStrategy`, `rebalanceToL2`).
3. Pull funds from strategies (`deallocateFromStrategy` / `deallocateAllFromStrategy`).
4. If urgent L2 liquidity is needed, execute `emergencySendToL2(...)`.
5. Reconcile balances and document each action.

### B) Token de-support during incident

1. Set `token.supported = false`.
2. Continue defensive exits:

- `deallocateFromStrategy`
- `deallocateAllFromStrategy`
- `emergencySendToL2`

3. Re-enable only after root-cause resolution.

### C) Suspected role compromise

1. Pause vault.
2. Revoke compromised role memberships.
3. Rotate keys and re-grant least privilege.
4. Audit events before unpause.

## Emergency Send Checklist

Before each `emergencySendToL2`:

1. Incident ticket/reference exists.
2. Caller has `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE`.
3. Token/amount/gas/refund recipient explicitly reviewed.
4. Confirm `msg.value == 0`.
5. Capture emitted `EmergencyToL2` event and bridge tx hash.

After call:

1. Check idle and strategy balances.
2. Confirm bridge execution and recipient-side confirmation.
3. Record remaining shortfall (if any).

## Native ETH Handling

- Vault may receive native ETH refunds.
- Sweep only via `sweepNative(to, amount)` and only by `VAULT_ADMIN_ROLE`.
- Treat every sweep as a privileged financial operation with explicit rationale.

## Validation Commands

Run before production changes:

```bash
npm run compile
npm run format
git diff --exit-code
npm run typecheck
npm run test
```

Optional fork test:

```bash
MAINNET_RPC_URL=<rpc-url> npm run test -- test/fork/AaveMainnetFork.test.ts
```

Optional pinned fork block:

```bash
MAINNET_RPC_URL=<rpc-url> MAINNET_FORK_BLOCK=22000000 npm run test -- test/fork/AaveMainnetFork.test.ts
```
