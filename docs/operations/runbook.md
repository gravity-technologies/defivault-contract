# Operations Runbook

## Metadata

- Audience: operators, deployers, incident responders
- Purpose: define deployment, operational, and incident procedures
- Canonical for: procedures and checklists
- See also: [../reference/roles-and-permissions.md](../reference/roles-and-permissions.md), [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)

## Deployment State and Audit Trail

Core proxy deployment and most post-deploy configuration are managed with Hardhat Ignition.
Vault upgrades use a single Hardhat task. Production prepares multisig calldata after deploying a new implementation with a hot wallet; staging/testnet execute directly with the task signer.

Source of truth for deployment records:

- `ignition/deployments/`
- versioned parameter files under `ignition/parameters/<environment>/`

Record these for every deployment:

- proxy addresses
- implementation addresses
- ProxyAdmin addresses
- deployment ids
- transaction hashes

Useful commands:

```bash
npx hardhat ignition deployments --network <network>
npx hardhat ignition status <deployment-id> --network <network>
npx hardhat ignition transactions <deployment-id> --network <network>
```

Local smoke orchestration:

```bash
npm run smoke:deployment
```

## Environment

Use `.env` only for network credentials. Keep deployment inputs in versioned Ignition parameter files.

Common env vars:

- `TESTNET_RPC_URL`
- `TESTNET_PRIVATE_KEY`

Shared parameter rule for vault core and native gateways:

- Use `ignition/parameters/<env>/core.json5` as the canonical file for both modules.
- Put repeated infra addresses in `$global`.
- Keep module-only values under `VaultCoreModule` and `NativeGatewaysModule`.

## Deployment Workflow

### 1. Deploy Vault Core

Prepare `ignition/parameters/<env>/core.json5` with:

- `$global.bridgeHub`
- `$global.grvtBridgeProxyFeeToken`
- `$global.wrappedNativeToken`
- `VaultCoreModule.deployAdmin`
- `VaultCoreModule.l2ChainId`
- `VaultCoreModule.l2ExchangeRecipient`
- `VaultCoreModule.yieldRecipient`

Command:

```bash
npm run deploy:vault -- \
  --network <network> \
  --parameters ignition/parameters/<env>/core.json5
```

Record:

- vault implementation and proxy addresses
- vault ProxyAdmin address
- deployment tx hashes

### 2. Deploy Strategy Core

Prepare `ignition/parameters/<env>/strategy-core.json5` with:

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

Record:

- strategy implementation and proxy addresses
- strategy ProxyAdmin address
- deployment tx hashes

### 3. Configure Supported Vault Tokens

Prepare `ignition/parameters/<env>/vault-token-config.json5` with:

- `vaultProxy`
- `token`
- `supported`

Command:

```bash
npm run config:vault-token -- \
  --network <network> \
  --parameters ignition/parameters/<env>/vault-token-config.json5
```

### 4. Add Strategy to Vault Registry

Prepare `ignition/parameters/<env>/vault-token-strategy.json5` with:

- `vaultProxy`
- `strategyProxy`
- `underlyingToken`
- `tokenSupported`
- `strategyWhitelisted`
- `strategyCap`

Command:

```bash
npm run deploy:vault-token-strategy -- \
  --network <network> \
  --parameters ignition/parameters/<env>/vault-token-strategy.json5
```

### 5. Grant Operational Roles

Prepare `ignition/parameters/<env>/roles-bootstrap.json5` with:

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

### 6. Set Up Yield-Recipient Timelock

Prepare `ignition/parameters/<env>/yield-recipient-bootstrap.json5` with:

- `vaultProxy`
- `minDelay`
- `proposers`
- `executors`
- `admin`

Command:

```bash
npm run deploy:yield-recipient-timelock -- \
  --network <network> \
  --parameters ignition/parameters/<env>/yield-recipient-bootstrap.json5
```

Operator rules:

- `setYieldRecipientTimelockController` is a one-time governance step.
- After setup, yield recipient updates must go through schedule/execute flow.

### 7. Deploy Native Gateways

Use the same `ignition/parameters/<env>/core.json5` file and fill:

- `$global.bridgeHub`
- `$global.grvtBridgeProxyFeeToken`
- `$global.wrappedNativeToken`
- `NativeGatewaysModule.vaultProxy`
- `NativeGatewaysModule.proxyAdminOwner`

Command:

```bash
npm run deploy:native-gateways -- \
  --network <network> \
  --parameters ignition/parameters/<env>/core.json5
```

Record:

- `NativeVaultGateway`
- `NativeBridgeGatewayImplementation`
- `NativeBridgeGatewayProxy`

### 8. Upgrades

Vault upgrade:

```bash
npx hardhat upgrade:vault -- \
  --network <network> \
  --parameters ignition/parameters/<env>/vault-upgrade.json5
```

The task deploys the new vault implementation with the active wallet, derives the proxy admin from the vault proxy, and either:

- prints the calldata for `upgradeAndCall` when `requiresMultisig: true`
- executes the upgrade directly when `requiresMultisig: false`

Strategy upgrade:

```bash
npm run upgrade:strategy -- \
  --network <network> \
  --parameters ignition/parameters/<env>/strategy-upgrade.json5
```

## Post-Deploy Verification Checklist

1. Confirm `paused() == false`.
2. Confirm expected role holders for all roles.
3. Confirm `bridgeHub`, `grvtBridgeProxyFeeToken`, `l2ChainId`, `l2ExchangeRecipient`, and `wrappedNativeToken`.
4. Confirm supported vault tokens and strategy registry state.
5. Confirm the configured `nativeBridgeGateway`.
6. Confirm all deployment outputs and tx hashes are attached to the deployment record.

## Normal Operations

### Strategy Capital Management

Calls:

- `allocateVaultTokenToStrategy(token, strategy, amount)`
- `deallocateVaultTokenFromStrategy(token, strategy, amount)`
- `deallocateAllVaultTokenFromStrategy(token, strategy)`

Operator rules:

- only allocate when the token is supported and the strategy is whitelisted
- use `tokenTotalsConservative(token)` for operational reads when partial strategy read failures must not block the workflow
- remember that withdraw-only strategies can remain `active` even after de-whitelisting

### Yield-Recipient Governance Updates

Schedule update:

```bash
npx hardhat yield-recipient:schedule-update \
  --network <network> \
  --parameters ignition/parameters/<env>/yield-recipient-schedule-update.json5
```

Execute update:

```bash
npx hardhat yield-recipient:execute-update \
  --network <network> \
  --parameters ignition/parameters/<env>/yield-recipient-execute-update.json5
```

Operator rules:

- `newYieldRecipient` must match between schedule and execute payloads
- `predecessor` and `salt` must match between schedule and execute payloads
- do not use direct admin updates as the production path once the timelock is configured

### Yield Harvest

Command:

```bash
npx hardhat ops:harvest-yield \
  --network <network> \
  --parameters ignition/parameters/<env>/harvest-yield.json5
```

Operator rules:

- harvest is blocked while paused
- harvest token input is the ERC20 vault token, not `address(0)`
- `minReceived` guards yield-recipient-side net receipt
- wrapped-native harvest pays the yield recipient in native ETH
- a single transaction emits both `VaultTokenDeallocatedFromStrategy` and `YieldHarvested`

### L1 -> L2 Top-Up

Use:

- `rebalanceErc20ToL2(token, amount)` for ERC20 bridge intent
- `rebalanceNativeToL2(amount)` for native bridge intent

Checks:

- caller has `REBALANCER_ROLE`
- vault is not paused
- token is marked `bridgeable` for the generic ERC20 bridge path
- `msg.value == 0`
- wrapped-native is not sent through the ERC20 bridge path
- amount is within `availableErc20ForRebalance(token)` or `availableNativeForRebalance()`

Note:

- `supported` means the token may be held and used by the vault
- `bridgeable` is a separate admin decision for the generic ERC20 shared-bridge flow

## Incident Response

### Market or Protocol Stress

1. `pause()`
2. stop normal allocate and rebalance activity
3. unwind strategy positions as needed
4. if urgent L2 liquidity is needed, use emergency bridge flows
5. reconcile balances and record each action

### Token De-Support During Incident

1. disable support for the affected vault token
2. continue defensive exits through deallocation and emergency bridge paths
3. re-enable only after root cause resolution

### Suspected Role Compromise

1. pause the vault
2. revoke compromised role memberships
3. rotate keys and re-grant least privilege
4. audit emitted events before unpause

### Failed Native Deposit Recovery

Prepare `ignition/parameters/<env>/native-bridge-gateway-claim-failed-deposit.json5` with:

- `sharedBridge`
- `nativeBridgeGatewayProxy`
- `chainId`
- `amount`
- `bridgeTxHash`
- `l2BatchNumber`
- `l2MessageIndex`
- `l2TxNumberInBatch`
- `merkleProof`

Command:

```bash
npx hardhat claim:failed-native-deposit \
  --network <network> \
  --parameters ignition/parameters/<env>/native-bridge-gateway-claim-failed-deposit.json5
```

Operator rules:

- use the `bridgeTxHash` emitted during the original native bridge send
- recovery should leave `NativeBridgeGateway` with no stranded native or wrapped-native balance

## Emergency Send Checklist

Before each `emergencyNativeToL2` or `emergencyErc20ToL2`:

1. incident ticket or reference exists
2. caller has `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE`
3. token and amount are explicitly reviewed
4. `msg.value == 0`
5. emitted bridge metadata is captured

After call:

1. check idle and strategy balances
2. confirm bridge execution or recipient-side confirmation
3. record any remaining shortfall

## Native ETH Operational Notes

- planned external ETH ingress should go through `NativeVaultGateway`
- integrations should call `depositToVault()` or use a full-gas native `call`
- do not rely on Solidity `.transfer()` or `.send()` for native ingress through `NativeVaultGateway`
- if `NativeVaultGateway` retains unexpected ETH or ERC20 balances, vault admins can recover them with
  `sweepNative(recipient, amount)` or `sweepToken(token, recipient, amount)`
- direct ETH sent to the vault is not normal operation
- strategy positions remain ERC20-only
- sweep unexpected native ETH from the vault itself only through `sweepNativeToYieldRecipient(amount)` with explicit
  operator rationale

## Validation Commands

Run before production changes:

```bash
npm run compile
npm run format
git diff --exit-code
npm run typecheck
npm run test
```

Security-sensitive changes should also run:

```bash
npm run slither
```
