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
| `harvestYieldFromStrategy`  | `VAULT_ADMIN_ROLE`                      | Yes                  | No                                 |
| `rebalanceToL2`             | `REBALANCER_ROLE`                       | Yes                  | Yes                                |
| `emergencySendToL2`         | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No                   | No                                 |

### Bridge Fee Model

- `rebalanceToL2` and `emergencySendToL2` require `msg.value == 0`.
- Vault mints base token and submits a BridgeHub two-bridges request.
- Native bridge intent uses boundary token `address(0)` (sentinel), canonicalized to wrapped native token internally.
- Passing wrapped native token directly to rebalance/emergency write APIs is invalid boundary input.

### Strategy Token Domain

- Strategy accounting domain is always ERC20.
- Strategies must not hold native ETH as principal-bearing position state.
- External native ETH ingress is canonicalized to wrapped native via `NativeToWrappedIngress` before strategy flows.
- Vault `receive()` is reserved for wrapped-native `withdraw` callbacks and forced-ETH recovery context.

### Emergency Behavior

- `emergencySendToL2` can be called while paused.
- If idle balance is insufficient, it performs best-effort strategy unwinds (bounded by max strategy count).
- If funds are still insufficient after unwind attempts, call reverts.
- Break-glass token tracking recovery is available via `setRootTrackingOverride(token, enabled, forceTrack)`.
  Use only for strategy-read-failure pinning scenarios with explicit operator rationale.

## Roles and Responsibilities

- `DEFAULT_ADMIN_ROLE` / `VAULT_ADMIN_ROLE`: governance, config, role admin, emergency actions.
- `ALLOCATOR_ROLE`: strategy allocation/deallocation.
- `REBALANCER_ROLE`: normal L1 -> L2 top-ups.
- `PAUSER_ROLE`: pause/unpause risk-on operations.

## Deployment State and Audit Trail

Core proxy deployment, post-deploy configuration, and upgrades are managed with Hardhat Ignition.

- Source of truth for deployment and operations: Ignition deployment state under `ignition/deployments/`.
- Keep parameter files, tx hashes, proxy addresses, and ProxyAdmin addresses in deployment records.
- Each transparent proxy has its own ProxyAdmin contract address; record per-proxy values.

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
  - `wrappedNativeToken`

Command:

```bash
npm run deploy:vault -- \
  --network <network> \
  --parameters ignition/parameters/<env>/vault-core.json5
```

Output to record:

- `VaultCoreModule#VaultImplementation` and `VaultCoreModule#VaultProxy` from Ignition deployed addresses
- `vaultProxyAdmin` read from the EIP-1967 admin slot
- deployment tx hashes from `npx hardhat ignition transactions <deployment-id>`

### Step 2: Deploy Aave Strategy Core

Prepare:

- `ignition/parameters/<env>/strategy-core.json5` with:
  - `vaultProxy`
  - `proxyAdminOwner`
  - `aavePool`
  - `underlyingToken`
  - `aToken`
  - `strategyName`

Command:

```bash
npm run deploy:strategy -- \
  --network <network> \
  --parameters ignition/parameters/<env>/strategy-core.json5
```

Output to record:

- `StrategyCoreModule#StrategyImplementation` and `StrategyCoreModule#StrategyProxy` from Ignition deployed addresses
- `strategyProxyAdmin` read from the EIP-1967 admin slot
- deployment tx hashes from `npx hardhat ignition transactions <deployment-id>`

### Step 3: Configure Token Support (Standalone)

Prepare:

- `ignition/parameters/<env>/token-config.json5` with:
  - `vaultProxy`
  - `token`
  - `supported`

Command:

```bash
npm run config:token -- \
  --network <network> \
  --parameters ignition/parameters/<env>/token-config.json5
```

### Step 4: Onboard Strategy in Vault Registry

Prepare:

- `ignition/parameters/<env>/token-strategy.json5` with:
  - `vaultProxy`
  - `strategyProxy`
  - `underlyingToken` (canonical principal token key)
  - `tokenSupported`
  - `strategyWhitelisted`
  - `strategyCap`

Command:

```bash
npm run deploy:token-strategy -- \
  --network <network> \
  --parameters ignition/parameters/<env>/token-strategy.json5
```

### Step 5: Bootstrap Initial Roles

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

### Step 6: Bootstrap Treasury Timelock Governance

Prepare:

- `ignition/parameters/<env>/treasury-bootstrap.json5` with:
  - `vaultProxy`
  - `minDelay`
  - `proposers`
  - `executors`
  - `admin`

Command:

```bash
npm run deploy:treasury-timelock -- \
  --network <network> \
  --parameters ignition/parameters/<env>/treasury-bootstrap.json5
```

Operational notes:

- `setTreasuryTimelock` is one-time bootstrap and should be treated as immutable governance wiring.
- After timelock is configured, treasury recipient updates must flow through schedule/execute operations.

### Step 7: Deploy Native Ingress Wrapper

Prepare:

- `ignition/parameters/<env>/native-ingress.json5` with:
  - `vaultProxy`
  - `wrappedNativeToken`

Command:

```bash
npm run deploy:native-ingress -- \
  --network <network> \
  --parameters ignition/parameters/<env>/native-ingress.json5
```

### Step 8: Upgrade Workflows (ProxyAdmin)

Vault upgrade:

```bash
npm run upgrade:vault -- \
  --network <network> \
  --parameters ignition/parameters/<env>/vault-upgrade.json5
```

Strategy upgrade:

```bash
npm run upgrade:strategy -- \
  --network <network> \
  --parameters ignition/parameters/<env>/strategy-upgrade.json5
```

## Post-Deploy Verification Checklist

1. Confirm `paused() == false`.
2. Confirm expected role holders for all roles.
3. Confirm `bridgeHub/baseToken/l2ChainId/l2ExchangeRecipient` match intended values.
4. Confirm token support and strategy whitelist state.
5. Confirm Ignition deployment outputs (implementation + proxy + tx hashes) are attached to deployment record.
6. Confirm per-proxy `ProxyAdmin` addresses are attached to deployment record.

## Normal Operations

### Strategy Capital Management

- Allocate: `allocateToStrategy(token, strategy, amount)`
- Partial deallocate: `deallocateFromStrategy(token, strategy, amount)`
- Full deallocate: `deallocateAllFromStrategy(token, strategy)`

Operator rules:

- Do not allocate unless token is supported and strategy is whitelisted.
- Use `totalAssetsStatus(token)`; non-zero `skippedStrategies` indicates degraded reporting.

### Treasury Governance Operations

Schedule treasury recipient update (timelock queue):

```bash
npm run treasury:schedule-update -- \
  --network <network> \
  --parameters ignition/parameters/<env>/treasury-schedule-update.json5
```

Execute queued treasury recipient update:

```bash
npm run treasury:execute-update -- \
  --network <network> \
  --parameters ignition/parameters/<env>/treasury-execute-update.json5
```

Operator rules:

- `newTreasury` must match between schedule and execute payloads.
- `predecessor`/`salt` must also match between schedule and execute.
- Do not treat direct admin `setTreasury` calls as a valid production path once timelock is set.

### Yield Harvest Operations

Harvest yield from strategy to current treasury:

```bash
npm run ops:harvest-yield -- \
  --network <network> \
  --parameters ignition/parameters/<env>/harvest-yield.json5
```

Operator rules:

- `harvestYieldFromStrategy` is blocked while paused.
- Token/strategy must be withdrawable in vault registry (whitelisted or withdraw-only active).
- Harvest token input is canonical principal token key (ERC20); `address(0)` is invalid for strategy-domain harvest.
- Harvest/cap math uses `principalBearingExposure(token)` scalar (not reporting component sums).
- Payout asset is principal-token based:
  - non-wrapped-native principal token -> ERC20 transfer to treasury,
  - wrapped-native principal token -> unwrap in vault then native ETH transfer to treasury.
- `YieldHarvested.token` remains the principal token key (wrapped-native for native-payout branch).
- Harvest unwind emits both `Deallocate` and `YieldHarvested` in the same transaction:
  - `Deallocate.received` is vault-side measured strategy unwind delta.
  - `YieldHarvested.received` is treasury-side net receipt used for `minReceived`.
- Use `minReceived` to enforce treasury-side net receipt constraints.
- Wrapped-native harvest enforces `minReceived` on treasury native balance delta.
- Never default `minReceived` to `0` unless explicitly operating without slippage protection.
- Native payout failure reverts with `NativeTransferFailed`.
- Handle `YieldNotAvailable` and `SlippageExceeded` as expected operational guards.

### Principal Sync Operations

- `syncStrategyPrincipal(token, strategy)` is a vault-admin reconciliation control.
- Once `lockPrincipalSync()` is executed, principal sync cannot be used again (irreversible lock).
- Execute principal sync only as an incident reconciliation action with ticketed rationale.

### L1 -> L2 Top-Up

Use:

- `rebalanceToL2(token, amount)`

Checks:

- caller has `REBALANCER_ROLE`
- vault not paused
- token supported
- `msg.value == 0`
- native intent uses `token = address(0)` sentinel
- explicit wrapped-native token boundary input is invalid
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
3. Token/amount explicitly reviewed.
4. Confirm `msg.value == 0`.
5. Capture emitted `EmergencyToL2` event and bridge tx hash.

After call:

1. Check idle and strategy balances.
2. Confirm bridge execution and recipient-side confirmation.
3. Record remaining shortfall (if any).

## Native ETH Handling

- Direct ETH ingress from non-wrapped-native senders is rejected by vault `receive()`.
- Planned external ETH ingress should route through `NativeToWrappedIngress`, which wraps and forwards to vault.
- Vault may still receive out-of-band native ETH via EVM edge cases (for example forced sends).
- Strategy holdings remain ERC20-domain; native ETH is not a strategy principal asset.
- Sweep only via `sweepNative(amount)` and only by `VAULT_ADMIN_ROLE`.
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
