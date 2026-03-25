# Operations Runbook

## Metadata

- Audience: operators, deployers, incident responders
- Purpose: define deployment, operational, and incident procedures
- Canonical for: procedures and checklists
- See also: [../reference/roles-and-permissions.md](../reference/roles-and-permissions.md), [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)

## Deployment State and Audit Trail

Core proxy deployment and bootstrap configuration are managed with Hardhat Ignition.
Operational strategy moves, yield harvests, and bridge operations are exposed as Hardhat tasks.
Vault upgrades use a single Hardhat task. Production prepares multisig calldata after deploying a new implementation with a hot wallet; staging/testnet execute directly with the task signer.

Source of truth for current live state:

- local operation records under `deployment-records/<environment>/<network>/`

Supporting deployment evidence:

- `ignition/deployments/`
- deployment parameter files under `ignition/parameters/<environment>/`
- operation parameter files under `tasks/parameters/<environment>/`
- `deployment-records/<environment>/<network>/`

Record these for every deployment:

- proxy addresses
- implementation addresses
- helper module addresses
- ProxyAdmin addresses
- deployment ids
- transaction hashes

Useful commands:

```bash
npx hardhat ignition deployments --network <network>
npx hardhat ignition status <deployment-id> --network <network>
npx hardhat ignition transactions <deployment-id> --network <network>
```

## Environment

Use `.env` only for network credentials. Keep deployment inputs in versioned parameter files.

Common env vars:

- `RPC_URL`
- `PRIVATE_KEY`

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

- `VaultStrategyOpsLib`
- `VaultBridgeLib`
- `VaultViewModule`
- `VaultOpsModule`
- vault implementation and proxy addresses
- vault ProxyAdmin address
- deployment tx hashes

### 2. Deploy Strategy Core

There are currently three strategy deployment paths in this repo:

- `npm run deploy:strategy`: Aave lane via `ignition/modules/StrategyCore.ts`
- `npm run deploy:strategy-v2:family` and `npm run deploy:strategy-v2:lane`: beacon-backed Aave V2 family and lanes
- `npm run deploy:gho-strategy:family` and `npm run deploy:gho-strategy:lane`: beacon-backed GHO / stkGHO family and lanes

#### Aave Strategy

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

#### Aave V2 Strategy Family

Prepare `ignition/parameters/<env>/strategy-v2-family.json5` with:

- `beaconOwner`

Command:

```bash
npm run deploy:strategy-v2:family -- \
  --network <network> \
  --parameters ignition/parameters/<env>/strategy-v2-family.json5
```

Record:

- strategy implementation address
- strategy beacon address
- deployment tx hashes
- note: this does not deploy a usable strategy proxy

#### Aave V2 Lane

Prepare `ignition/parameters/<env>/strategy-v2-lane.json5` with:

- `strategyBeacon`
- `vaultProxy`
- `aavePool`
- `vaultToken`
- `aToken`
- `strategyName`

Command:

```bash
npm run deploy:strategy-v2:lane -- \
  --network <network> \
  --parameters ignition/parameters/<env>/strategy-v2-lane.json5
```

Record:

- strategy proxy address
- deployment tx hashes
- this is the usable strategy instance to register in the vault

#### GHO / stkGHO Strategy Family

Prepare `ignition/parameters/<env>/gho-strategy-core.json5` with:

- `beaconOwner`

Command:

```bash
npm run deploy:gho-strategy:family -- \
  --network <network> \
  --parameters ignition/parameters/<env>/gho-strategy-core.json5
```

Record:

- strategy implementation address
- strategy beacon address
- deployment tx hashes
- note: this does not deploy a usable strategy proxy

#### GHO / stkGHO Strategy Lane

Prepare `ignition/parameters/<env>/gho-strategy-lane.json5` with:

- `strategyBeacon`
- `vaultProxy`
- `vaultToken`
- `ghoToken`
- `stkGhoToken`
- `gsmAdapter`
- `stkGhoStakingAdapter`
- `stkGhoRewardsDistributor`
- `strategyName`

Command:

```bash
npm run deploy:gho-strategy:lane -- \
  --network <network> \
  --parameters ignition/parameters/<env>/gho-strategy-lane.json5
```

Record:

- strategy proxy address
- deployment tx hashes
- this is the usable strategy instance to register in the vault

Additional operator requirement for the GHO lane:

- before reimbursing exits are relied on, admin must rotate `yieldRecipient` to a compatible treasury contract,
- that treasury must authorize the vault; lane reimbursement config and budget are still an operator responsibility,
- current intended GHO policy is entry cap `0`, exit cap `7`, `policyActive = true`,
- incident response should not treat treasury reimbursement as bridgeable liquidity.

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

### 4b. Activate V2 Policy For V2 Lanes

Whitelisting a V2 lane does not turn the V2 policy on.

Today `setStrategyPolicyConfig(...)` is not wrapped in a dedicated task or Ignition module.
Prepare direct admin or multisig calldata against the vault proxy instead.

Recommended configs:

- `AaveV3StrategyV2`: `(0, 0, true)`
- `GsmStkGhoStrategy`: `(0, 7, true)`

For reimbursing lanes, do not activate policy until:

- `yieldRecipient` is a compatible treasury,
- the vault is authorized on that treasury,
- the treasury budget is configured for the correct `(strategy, token)` lane before those reimbursing flows are relied on.

### 5. Grant Operational Roles

Prepare `ignition/parameters/<env>/roles-bootstrap.json5` with:

- `vaultProxy`
- `allocator`
- `rebalancer`
- `pauser`

Command:

```bash
npm run deploy:roles-bootstrap -- \
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
  --parameters tasks/parameters/<env>/vault-upgrade.json5
```

The task deploys the new vault implementation with the active wallet, derives the proxy admin from the vault proxy, and either:

- prints the calldata for `upgradeAndCall` when `requiresMultisig: true`
- executes the upgrade directly when `requiresMultisig: false`

Before using the task, run:

```bash
npm run size:check:vault
npm exec hardhat test test/unit/VaultUpgrade.test.ts
```

See [vault-upgrades-and-v2-policy.md](vault-upgrades-and-v2-policy.md) for the full upgrade checklist and V2 lane activation flow.

Strategy upgrade:

```bash
npm run upgrade:strategy -- \
  --network <network> \
  --parameters tasks/parameters/<env>/strategy-upgrade.json5
```

## Post-Deploy Verification Checklist

1. Confirm `paused() == false`.
2. Confirm expected role holders for all roles.
3. Confirm `bridgeHub`, `grvtBridgeProxyFeeToken`, `l2ChainId`, `l2ExchangeRecipient`, and `wrappedNativeToken`.
4. Confirm the treasury vault proxy has minter permission on `grvtBridgeProxyFeeToken` before any L1 -> L2 rebalance is attempted.
5. Confirm supported vault tokens and strategy registry state.
6. Confirm the configured `nativeBridgeGateway`.
7. Confirm all deployment outputs and tx hashes are attached to the deployment record.
8. For beacon-backed V2 strategy deployments, verify each deployment dir separately:
   - family bootstrap: `npm run verify:v2-strategies -- --deployment-dir <family-ignition-deployment-dir>`
   - lane proxy: `npm run verify:v2-strategies -- --deployment-dir <lane-ignition-deployment-dir>`

## Normal Operations

### Strategy Capital Management

Commands:

```bash
npm run ops:allocate-to-strategy -- \
  --network <network> \
  --parameters tasks/parameters/<env>/allocate-to-strategy.json5

npm run ops:deallocate-from-strategy -- \
  --network <network> \
  --parameters tasks/parameters/<env>/deallocate-from-strategy.json5

npm run ops:deallocate-all-from-strategy -- \
  --network <network> \
  --parameters tasks/parameters/<env>/deallocate-all-from-strategy.json5
```

Parameter shape:

- `vaultProxy`
- `token`
- `strategy`
- `amount` for allocate and partial deallocate

These commands are task-backed operations, not Ignition deployments.

Operator rules:

- only allocate when the token is supported and the strategy is whitelisted
- use `tokenTotalsConservative(token)` for operational reads when partial strategy read failures must not block the workflow
- remember that withdraw-only strategies can remain `active` even after de-whitelisting

### Yield-Recipient Governance Updates

Schedule update:

```bash
npx hardhat yield-recipient:schedule-update \
  --network <network> \
  --parameters tasks/parameters/<env>/yield-recipient-schedule-update.json5
```

Execute update:

```bash
npx hardhat yield-recipient:execute-update \
  --network <network> \
  --parameters tasks/parameters/<env>/yield-recipient-execute-update.json5
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
  --parameters tasks/parameters/<env>/harvest-yield.json5
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
4. if urgent L2 liquidity is needed, deallocate the chosen lanes and then bridge through the normal path after unpausing
5. reconcile balances and record each action

### Token De-Support During Incident

1. disable support for the affected vault token
2. continue defensive exits through deallocation; if L2 liquidity is needed later, restore support and use the normal bridge path
3. re-enable only after root cause resolution

### Suspected Role Compromise

1. pause the vault
2. revoke compromised role memberships
3. rotate keys and re-grant least privilege
4. audit emitted events before unpause

### Failed Native Deposit Recovery

Prepare `tasks/parameters/<env>/native-bridge-gateway-claim-failed-deposit.json5` with:

- `nativeBridgeGatewayProxy`
- `bridgeTxHash`
- `l2BatchNumber`
- `l2MessageIndex`
- `l2TxNumberInBatch`
- `merkleProof`

Command:

```bash
npx hardhat claim:failed-native-deposit \
  --network <network> \
  --parameters tasks/parameters/<env>/native-bridge-gateway-claim-failed-deposit.json5
```

Operator rules:

- use the `bridgeTxHash` emitted during the original native bridge send
- the gateway now derives `chainId`, native token sentinel, and amount from its stored bridge record and performs claim
  plus recovery atomically
- recovery should leave `NativeBridgeGateway` with no stranded native or wrapped-native balance

## Incident-Time L2 Restoration

There is no dedicated emergency bridge method.

Use this operator workflow instead:

1. pause the vault if risk-on actions must stop
2. deallocate the specific lanes you want to unwind, in the order you choose
3. restore any required token support flags for the normal bridge path
4. unpause the vault
5. run `rebalanceNativeToL2` or `rebalanceErc20ToL2`
6. confirm bridge execution and remaining idle balances

This keeps bridge behavior identical in normal and incident operation. The only manual step is choosing which positions to unwind first.

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
npm run test:fork
```

Security-sensitive changes should also run:

```bash
npm run slither
```
