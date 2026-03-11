# GRVT L1 TreasuryVault Contract

This repository contains the **GRVT L1 TreasuryVault contract** and its Hardhat-based development environment, using the native Node.js test runner (`node:test`) and `viem` for Ethereum interactions.

In simple terms, this contract helps put GRVT TVL to work by allocating funds into established DeFi venues such as Aave, so the vault can generate on-chain yield in a structured way.

## Project Overview

This repository contains:

- `GRVTL1TreasuryVault`: L1 vault with RBAC, pause semantics, strategy routing, and L1->L2 rebalance/emergency flows.
- `AaveV3Strategy`: vault-only strategy integration for Aave v3 (USDT-first).

The design enforces strict asset-flow restrictions, strategy whitelisting, and emergency controls.

## Architecture and Major Flows

### High-Level Structure

Core system topology (governance, vault, strategy execution, and bridge routing).

```text
                         +----------------------------------+
                         |          Governance/Admin        |
                         |   (DEFAULT_ADMIN, VAULT_ADMIN)   |
                         +-----------------+----------------+
                                           |
                                           v
                         +---------------------------+
                         |    GRVTL1TreasuryVault    |
                         |     (upgradeable core)    |
                         +----+-----------------+----+
                              |                 |
         allocate/deallocate  |                 | requestL2TransactionTwoBridges(...)
                              v                 v
                     +----------------+   +---------------------------+
                     | Yield Strategy |   | BridgeHub + SharedBridge  |
                     | (AaveV3 first) |   | (two-bridges request)     |
                     +--------+-------+   +-------------+-------------+
                              |                           |
                              v                           v
                      External DeFi venue         L1 custody + L2 routing
```

Operator call path into the vault (`REBALANCER` / `PAUSER` workflows).

```text

  +---------------------+        calls
  |  Rebalancer/Ops     +-----------------------> GRVTL1TreasuryVault
  | (REBALANCER/PAUSER) |
  +---------------------+

```

Native vault-entry path via `NativeVaultGateway` into canonical wrapped-native vault balances.

```text
  +-------------------------+   external ETH   +---------------------------+  wrapped-native transfer
  | Native ETH Sender/User  +----------------->+    NativeVaultGateway     +-------------------------> GRVTL1TreasuryVault
  +-------------------------+                  |   (wrap + forward only)   |
                                               +---------------------------+
```

### Fund-Moving Policy Matrix

| Function                                     | Required caller                         | Blocked by pause | Requires `principalToken.supported` |
| -------------------------------------------- | --------------------------------------- | ---------------- | ----------------------------------- |
| `allocatePrincipalToStrategy`                | `ALLOCATOR_ROLE`                        | Yes              | Yes                                 |
| `deallocatePrincipalFromStrategy`            | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No               | No                                  |
| `deallocateAllPrincipalFromStrategy`         | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No               | No                                  |
| `rebalanceNativeToL2` / `rebalanceErc20ToL2` | `REBALANCER_ROLE`                       | Yes              | Yes                                 |
| `emergencyNativeToL2` / `emergencyErc20ToL2` | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No               | No                                  |

### Terminology

- **Principal token key**: ERC20 token argument accepted by principal/accounting APIs.
  Example: `allocatePrincipalToStrategy(USDT, strategy, amount)`.
- **Native path**: explicit native bridge methods (`rebalanceNativeToL2` / `emergencyNativeToL2`) that operate on wrapped-native internally and route bridge execution through `NativeBridgeGateway`.
- **Canonical token key**: internal normalized ERC20 storage/accounting key.
  Example: native bridge paths operate on wrapped-native principal key internally.
- **Token-strategy binding**: one `(token, strategy)` pair with independent lifecycle and cap.
  Example: `(USDT, AaveUsdtStrategy)` is one binding with its own permission state.
- **TokenAmountComponent**: one exact-token line item returned inside `strategy.positionBreakdown(principalToken)`.
  Example: `{ token: aUSDT, amount: 100e6 }`.
- **Tracked principal token**: principal token included in `getTrackedPrincipalTokens()` for TVL ingestion.
  Example: tracked set includes principal tokens such as `USDT` and `WETH`.

### Strategy Lifecycle (`whitelisted` vs `active`)

For each `(token, strategy)` pair, the vault tracks two different concepts:

- `whitelisted`: allocation permission for new funds.
- `active`: membership in token-domain withdraw/reporting set.

Why `active` is needed:

- A strategy can be de-whitelisted but still hold funds.
- In that withdraw-only phase, allocation must be blocked, but deallocation and emergency unwind must still include the strategy.
- `active` provides O(1) membership checks for these paths instead of repeatedly scanning strategy arrays.

Lifecycle states:

1. Not registered: `whitelisted = false`, `active = false`.
2. Whitelisted: `whitelisted = true`, `active = true`.
3. Withdraw-only: `whitelisted = false`, `active = true` (still deallocatable/unwindable).
4. Removed: `whitelisted = false`, `active = false` (after exposure is drained and entry is removed).

### Token Registry and Raw TVL Accounting

The vault reports TVL in raw token units (no USD conversion inside the contract).

For each token, accounting is deterministic:

```text
totalExactAssets(token) = idleAssets(token) + sum(component.amount where component.token == token across active strategies)
```

Where:

- `idleAssets(token)` is the vault's direct ERC20 balance.
- `strategy.exactTokenBalance(token)` returns the strategy-held amount for that exact token only.
- `strategy.positionBreakdown(principalToken)` is a separate diagnostic surface that can show principal-domain shape such as receipt token plus residual underlying.
- The vault never converts amounts across token denominations while reporting.

The vault maintains a token registry for TVL discovery:

- `getTrackedPrincipalTokens()` returns the current token set that should be tracked for TVL.
- `isTrackedPrincipalToken(token)` checks if a token is currently in that set.
- Registry scope is principal tokens only (canonical storage keys).
- Principal tokens remain tracked while they still have exposure, even if `principalToken.supported` is disabled.
- A principal token is removed from tracking only when unsupported and fully unwound.
- Tracker sync happens on vault write paths (for example `setPrincipalTokenConfig`, strategy whitelist changes, allocate/deallocate, rebalance/emergency sends).
- Read paths (`getTrackedPrincipalTokens`/`isTrackedPrincipalToken`) are storage-backed and do not call strategy reporting methods.
- Component tokens are not auto-registered in this discovery list.
- Exact-token component reporting remains available through `totalExactAssets*` scans over global active strategies.

### How 3rd-Party Trackers Should Compute TVL

For accurate on-chain TVL ingestion:

1. Read tracked principal-token list:
   - `tokens = getTrackedPrincipalTokens()`
2. Read batch totals:
   - `statuses = totalExactAssetsBatch(tokens)`
3. Interpret each token row:
   - `statuses[i].total` is the raw token amount for `tokens[i]`.
   - `statuses[i].skippedStrategies == 0` means no strategy read failures for that token.
   - `statuses[i].skippedStrategies > 0` means total is a conservative lower bound (one or more strategies could not be read safely).
4. (Optional) For diagnostics, inspect:
   - `getPrincipalTokenStrategies(token)` for token-keyed active entries.
   - `strategyPositionBreakdown(token, strategy)` for any active strategy when you need per-strategy principal-domain details.

Notes:

- The contract does not provide cross-token aggregation or pricing.
- Any USD TVL metric should be computed off-chain by applying external price feeds to raw per-token totals.
- For non-principal component tokens (for example receipt tokens), callers query `totalExactAssets(componentToken)` directly.

### Normal Yield Flow (Allocate / PrincipalDeallocatedFromStrategy)

```text
[ALLOCATOR role]
      |
      v
GRVTL1TreasuryVault.allocatePrincipalToStrategy(token, strategy, amount)
      |
      +--> checks: token supported, strategy whitelisted, cap, pause
      +--> token approve(strategy)
      +--> strategy.allocate(...)

[ALLOCATOR or VAULT_ADMIN]
      |
      v
GRVTL1TreasuryVault.deallocatePrincipalFromStrategy(...)
      |
      +--> checks: strategy is withdrawable (whitelisted or still active in strategy set)
      +--> strategy.deallocate(...)
      +--> vault measures actual received via balance delta (does not trust strategy return value)
      +--> funds return to vault idle balance
```

### Normal Rebalance Flow (L1 -> L2 Top-Up)

```text
[REBALANCER role]
      |
      v
GRVTL1TreasuryVault.rebalanceNativeToL2(amount)
or
GRVTL1TreasuryVault.rebalanceErc20ToL2(erc20Token, amount)
      |
      +--> checks: paused? no, principal token supported, bridge config valid
      +--> enforces: l2ExchangeRecipient fixed at initialization (no admin setter)
      +--> both paths require msg.value == 0
      +--> native path mints base token, transfers WETH + base token to NativeBridgeGateway
      +--> NativeBridgeGateway unwraps WETH and submits BridgeHub request as deposit sender
      +--> ERC20 path rejects explicit wrapped-native bridge-out
      +--> ERC20 path mints base token and calls bridgeHub.requestL2TransactionTwoBridges(...)
      |
      v
BridgeHub dispatches shared bridge deposit and emits L2 tx hash metadata
```

Note:

- External rebalance calls are ETH-free (`msg.value` must be `0`).
- Bridge execution cost is funded via minted BaseToken (`mintValue`).
- For native-intent sends, the vault transfers WETH + BaseToken to `NativeBridgeGateway`; the gateway unwraps and forwards ETH value to BridgeHub.
- For ERC20-intent sends, bridge submission uses zero ETH value.
- Standard L1 transaction gas still applies for the caller submitting the transaction.

### Why BaseToken Minting Exists (Private Chain Deposit Control)

GRVT intentionally uses a controlled base-token model for L1 -> L2 bridging.

- Goal: enforce private-chain deposit policy (including AML controls).
- Practical rule: only flows backed by GRVT-controlled BaseToken can be bridged into the private L2 environment.
- In this vault, every L1 -> L2 rebalance computes the bridge `mintValue`, mints BaseToken, then submits a two-bridges request through BridgeHub.

Operational implication:

- The contract/address that performs this bridge flow must have minter permission in GRVT bridge infrastructure.
- In GRVT's proxy-bridging stack, this permission is managed on `GRVTBridgeProxy`:
  https://github.com/gravity-technologies/proxy-bridging-contracts/blob/f79d8f9beca5712c658ea9d6074f2f75ea2e70ea/contracts/proxy-bridging/GRVTBridgeProxy.sol

If minter permission is missing, bridge top-ups fail because required BaseToken cannot be minted.

### Emergency Liquidity Restoration Flow

```text
[REBALANCER or VAULT_ADMIN]
      |
      v
GRVTL1TreasuryVault.emergencyNativeToL2(amount)
or
GRVTL1TreasuryVault.emergencyErc20ToL2(erc20Token, amount)
      |
      +--> allowed while paused
      +--> callable even if token support has been disabled
      +--> pulls liquidity from active strategies (including withdraw-only de-whitelisted entries)
      +--> vault uses measured balance deltas per unwind step
      +--> requires msg.value == 0
      +--> mints base token and submits TwoBridges request
```

### Native Vault Gateway (`NativeVaultGateway`)

`NativeVaultGateway` is the canonical external ETH -> vault adapter.

Purpose:

- Accept externally sourced native ETH.
- Wrap ETH into the configured wrapped-native ERC20 (for example WETH).
- Forward wrapped-native tokens directly to the vault.
- Keep the vault's investment/strategy accounting in canonical ERC20 domain.

Deployment wiring:

- Constructor: `NativeVaultGateway(wrappedNativeToken, vault)`.
- Deployment reverts unless both addresses are non-zero contract addresses.

Runtime behavior:

- `depositToVault()` (payable):
  - requires `msg.value > 0`,
  - calls `wrappedNativeToken.deposit{value: msg.value}()`,
  - transfers wrapped-native tokens to `vault`,
  - emits `NativeDepositedToVault(sender, amount)`.
- `receive()` (payable): same behavior as `depositToVault()`.
- `fallback()` (payable): always reverts (calldata-bearing sends are rejected).

Operational notes:

- The gateway is designed not to retain persistent ETH or wrapped-native balances in normal flow.
- Direct ETH sends to the vault are restricted by vault-side sender checks; planned external ETH ingress should route through this gateway.

### Native Bridge Gateway (`NativeBridgeGateway`)

`NativeBridgeGateway` is the canonical L1 native bridge execution and failed-deposit recovery adapter.

Purpose:

- Receive wrapped-native and base token from the vault for native L1 -> L2 bridge sends.
- Become the zkSync deposit sender for native bridge requests.
- Receive externally claimed failed native deposits back on L1 without sending raw ETH to the vault.
- Wrap already-claimed recovered ETH back into wrapped-native and return it to the vault.

Deployment wiring:

- Deploy `NativeBridgeGateway` implementation + `TransparentUpgradeableProxy`.
- Initialize proxy with `initialize(wrappedNativeToken, baseToken, bridgeHub, vault)`.
- The vault must be configured post-deploy via `setNativeBridgeGateway(nativeBridgeGatewayProxy)`.

Runtime behavior:

- `bridgeNativeToL2(...)`:
  - callable only by the vault,
  - unwraps wrapped-native held by the gateway,
  - approves BridgeHub's shared bridge for `mintValue`,
  - submits native two-bridges request with the gateway as deposit sender.
- External failed-deposit claim:
  - BridgeHub `claimFailedDeposit(...)` is called outside the gateway with the gateway as `depositSender`.
  - claimed ETH is delivered to the gateway boundary.
- `recoverClaimedNativeDeposit(...)`:
  - permissionless,
  - wraps already-claimed ETH held by the gateway,
  - transfers wrapped-native back to the vault,
  - marks the bridge record as recovered.
- `receive()` (payable):
  - accepts ETH only from wrapped-native unwraps and BridgeHub shared-bridge claims.

### ETH Boundary

The system intentionally keeps raw ETH confined to narrow, explicit boundaries. The point is not only safety from arbitrary ETH sends; it is also to keep vault accounting and operator workflows deterministic.

Why the split exists:

- The vault's accounting domain is ERC20-only; native exposure is represented internally as wrapped-native.
- The vault intentionally rejects arbitrary ETH sends and should not be the normal custody point for raw ETH.
- External native inflow therefore needs a wrapper boundary before funds enter vault accounting.
- Native L1 -> L2 bridge execution needs a separate boundary because if the vault were the native deposit sender, any later native return on L1 would try to send ETH back to the vault.
- `NativeVaultGateway` handles user-facing native entry and immediately normalizes ETH into wrapped-native.
- `NativeBridgeGateway` handles bridge-facing native exit/return and ensures any returned native value is normalized back into wrapped-native before re-entering vault accounting.

| Contract              | May receive ETH from                                | Why ETH is allowed                                                                                       | Expected steady-state ETH balance                              |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GRVTL1TreasuryVault` | `wrappedNativeToken` only                           | Wrapped-native unwrap during internal native payout paths already modeled by vault logic                 | `0` except transient unwrap windows or accidental/forced sends |
| `NativeVaultGateway`  | External users / operators                          | Planned external native inflow that is immediately wrapped and forwarded to vault                        | `0`                                                            |
| `NativeBridgeGateway` | `wrappedNativeToken` and zkSync `sharedBridge` only | Native bridge submission unwraps WETH here; failed native deposits are reclaimed here before re-wrapping | `0` after successful bridge / claim flows                      |

Boundary rules:

- Raw ETH should enter the vault system from users only through `NativeVaultGateway`.
- Raw ETH should leave the vault system to zkSync only through `NativeBridgeGateway`.
- Failed native deposit recovery must terminate at `NativeBridgeGateway`, not at the vault.
- The vault should treat any non-wrapper ETH balance as exceptional and outside normal accounting.

1. Vault transfers wrapped-native and base token into `NativeBridgeGateway`.
2. `NativeBridgeGateway` submits the native bridge request as the L1 native deposit sender.
3. If the native bridge asset is later returned on L1, it returns to `NativeBridgeGateway`, not to the vault.
4. `NativeBridgeGateway` converts returned ETH back into wrapped-native before sending funds back to the vault.

Operational consequences:

- `refundRecipient` remains the L2 refund address for execution-side refunds; it does not solve the vault-side native return path.
- Native bridge operations must not be used until `setNativeBridgeGateway(...)` is configured on the vault.
- A successful recovery should leave `NativeBridgeGateway` with zero ETH and zero wrapped-native balance.

### Core Config (Initializer)

- `initialize(admin, bridgeHub, baseToken, l2ChainId, l2ExchangeRecipient, wrappedNativeToken, yieldRecipient)` sets role admins and core vault config.
- `bridgeHub`, `baseToken`, and `l2ChainId` define the L1 -> L2 bridge execution context.
- `l2ExchangeRecipient` is fixed at initialization (no admin setter exposed here).
- `wrappedNativeToken` is the canonical internal token key for native exposure accounting.
- `nativeBridgeGateway` is configured separately after deployment because it depends on the deployed vault proxy address.
- Native sweep scaffolding is restricted to admin and sends only to configured yield recipient.
- Initial yield recipient must be explicitly provided and must be different from `admin`.

## Interface Reporting Model

### Native and Canonical Token Rules

- Native bridge paths are explicit (`rebalanceNativeToL2`, `emergencyNativeToL2`); there is no native sentinel API input.
- Internal accounting keys and read/reporting surfaces use canonical ERC20 addresses.
- Native exposure is represented as wrapped native token on read surfaces.
- `allocatePrincipalToStrategy` does not implicitly wrap native ETH and requires canonical idle funds.
- Strategy domain is always ERC20: strategies hold principal tokens (for native exposure, wrapped native), not native ETH.
- Native ingress is restricted: direct ETH sends from non-wrapper senders revert; `NativeVaultGateway` is the canonical external ETH ingress path.

### Native ETH/Wrapped-Native Invariants (Why)

- zkSync bridge integration here supports native ETH branch and non-wrapped-native ERC20 branch; explicit wrapped-native bridge-out is rejected.
- To keep vault/strategy logic simple and deterministic, strategy accounting is ERC20-only and native exposure is always modeled as wrapped-native internally.
- Inflow invariant: external native ETH must be wrapped first through `NativeVaultGateway` before it enters vault accounting.
- Outflow invariant 1 (L1 -> L2 rebalance/emergency): wrapped-native leaves the vault through `NativeBridgeGateway`, which unwraps and bridges as native ETH.
- Outflow invariant 2 (harvest -> yield recipient): wrapped-native principal harvest pays yield recipient in native ETH to reduce operational conversion overhead and keep ETH available for gas/ops usage.
- Failed native deposit recovery invariant: recovered ETH must return to `NativeBridgeGateway`, then be re-wrapped and re-enter vault accounting only as wrapped-native.

### Token-Separated Strategy Reporting

- `IYieldStrategy.exactTokenBalance(token)` returns the strategy-held amount for that exact token address only.
- `IYieldStrategy.positionBreakdown(principalToken)` returns a principal-domain `StrategyAssetBreakdown` for diagnostics.
- Component amounts remain in each component token's native units; no cross-token conversion is done in reporting.
- Unsupported exact-token / principal-domain queries return `0` / empty components.
- `totalExactAssets(token)` / status variants scan global active strategies, so component-token queries (for example `aUSDT`) are supported even when strategy registration is keyed by a different underlying token.
- `IL1TreasuryVault.totalExactAssets(token)` returns strict exact-token totals and reverts on invalid strategy reads.
- `IL1TreasuryVault.totalExactAssetsStatus(token)` and batch status variants skip invalid strategies and report `skippedStrategies`.
- Non-underlying component token queries (for example receipt tokens) are valid exact-token queries.
- Break-glass tracked-principal override exists for admin recovery when conservative read-failure handling pins principal-token tracking.

### Harvest and Cap Scalar Path

- Harvest and cap logic are based on `IYieldStrategy.principalBearingExposure(token)`.
- This scalar path is separate from reporting components and may use strategy-specific conversion policies.
- Unsupported token queries for `principalBearingExposure(token)` return `0`.
- Harvest/principal APIs use canonical principal token keys (ERC20); `address(0)` is not a strategy token key.
- Harvest payout policy is principal-token based:
  - if principal token is not wrapped native, yield recipient receives ERC20 directly;
  - if principal token is wrapped native, vault unwraps and yield recipient receives native ETH.
- `minReceived` is enforced on yield-recipient-side net receipt:
  - ERC20 balance delta for non-wrapped-native harvest,
  - native ETH balance delta for wrapped-native harvest.
- Current accounting/reporting scope excludes reward and incentive tokens.

## Protocol-Agnostic Adapter Guidance

The strategy interface is protocol-agnostic. Adapters must unify principal-bearing exposure while preserving exact-token reporting:

- Aave V3 style rebasing receipt token:
  - implemented in `AaveV3Strategy` in this repo.
  - `exactTokenBalance(aUSDT)` reports invested receipt-token units.
  - `positionBreakdown(USDT)` can include `aUSDT` as invested principal and `USDT` residual.
  - scalar example: `principalBearingExposure(USDT) = aUSDT + USDT`, using assumption `1 aUSDT = 1 USDT` (scalar path only).
  - `deallocate`/`deallocateAll` sweep residual strategy-held underlying to vault to avoid dust-lock exposure.
  - unsupported scalar domains return `0` (non-reverting).
- Compound III style index-based accounting:
  - `exactTokenBalance(baseToken)` reports exact token units only.
  - `positionBreakdown(principalToken)` may be simple or empty where accounting is purely index-based.
  - scalar is derived from principal plus index accrual in base-token domain.
- Morpho/ERC4626 share-vault style accounting:
  - `positionBreakdown(principalToken)` can include vault share token invested principal plus underlying residual.
  - scalar is derived by share-to-asset conversion in underlying domain (`convertToAssets` style).

These examples are theoretical adapter patterns; this scope does not add new Compound or Morpho strategy contracts.

## Risk Controls Semantics

- `rebalanceNativeToL2`/`rebalanceErc20ToL2` use conservative availability checks (`availableNativeForRebalance`/`availableErc20ForRebalance`) and role gating.
- `emergencyNativeToL2`/`emergencyErc20ToL2` intentionally bypass pause and principal-token-support restrictions to prioritize incident-time liquidity restoration.
- Emergency actions remain role-gated and should be used under incident procedures defined in `docs/operations-runbook.md`.

## Usage

### Running Tests

Run all tests:

```shell
npm run test
```

### Current Test Matrix

- `test/unit/*`: vault policy, RBAC, config/upgrade, reporting, and strategy integration behavior.
- `test/adversarial/*`: reentrancy, malformed/fee-on-transfer ERC20 behavior, unwind failure handling, and bridge-path hardening.
- `test/invariant/*`: accounting consistency across randomized operation sequences.
- Default unit/adversarial/invariant suites are deterministic and mock-based.

Run fork integration tests (requires mainnet RPC):

```shell
MAINNET_RPC_URL=<rpc-url> npx hardhat test test/fork/*.ts
```

Optional fork block pin:

```shell
MAINNET_RPC_URL=<rpc-url> MAINNET_FORK_BLOCK=22000000 npx hardhat test test/fork/*.ts
```

### Deployment Smoke Test

Smoke test the Ignition deployment path end-to-end (vault core, strategy core,
token-strategy onboarding, roles bootstrap, native ingress):

```shell
npx hardhat node --hostname 127.0.0.1 --port 8545
```

In a second terminal:

```shell
npm run smoke:deployment
```

The smoke runner writes debugging artifacts to `smoke-artifacts/`:

- command stdout/stderr logs
- per-module Ignition deployed-address snapshots
- assertion logs and summary

### Deployments and Ops

Use `.env` for network credentials (`SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY`)
and JSON5 parameter files under `ignition/parameters/`.

All core deployment, configuration, and upgrades are managed by Ignition modules.
Core proxy deployments use OpenZeppelin `TransparentUpgradeableProxy` artifacts loaded
directly from `@openzeppelin/contracts/build/contracts`.

Deploy vault core (implementation + transparent proxy):

```shell
npm run deploy:vault -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/vault-core.json5
```

Deploy Aave strategy core (implementation + transparent proxy):

```shell
npm run deploy:strategy -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/strategy-core.json5
```

Record deployed addresses from `ignition/deployments/<deployment-id>/deployed_addresses.json`.
For each proxy, also read the EIP-1967 admin slot to capture its `ProxyAdmin` address
for upgrade modules.

Onboard strategy into the vault registry (set principal-token support + strategy whitelist):

```shell
npm run deploy:principal-token-strategy -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/principal-token-strategy.json5
```

Deploy native vault + bridge gateways:

```shell
npm run deploy:native-gateways -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/native-gateways.json5
```

Upgrade the native bridge gateway proxy:

```shell
npm run upgrade:native-bridge-gateway -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/native-bridge-gateway-upgrade.json5
```

Claim a failed native deposit back to the gateway and immediately re-wrap it to the vault:

```shell
npm run claim:failed-native-deposit -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/native-bridge-gateway-claim-failed-deposit.json5
```

Configure principal-token support independently:

```shell
npm run config:principal-token -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/principal-token-config.json5
```

Bootstrap vault roles:

```shell
npm run roles:bootstrap -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/roles-bootstrap.json5
```

Bootstrap yield-recipient timelock governance (one-time):

```shell
npm run deploy:yield-recipient-timelock -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/yield-recipient-bootstrap.json5
```

Schedule a yield recipient update through timelock:

```shell
npm run yield-recipient:schedule-update -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/yield-recipient-schedule-update.json5
```

Execute a ready yield recipient update through timelock:

```shell
npm run yield-recipient:execute-update -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/yield-recipient-execute-update.json5
```

Execute a harvest operation (strategy -> yield recipient):

```shell
npm run ops:harvest-yield -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/harvest-yield.json5
```

Upgrade vault proxy (ProxyAdmin `upgradeAndCall`):

```shell
npm run upgrade:vault -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/vault-upgrade.json5
```

Upgrade strategy proxy (ProxyAdmin `upgradeAndCall`):

```shell
npm run upgrade:strategy -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/strategy-upgrade.json5
```

Inspect Ignition deployment state for post-deploy operations:

```shell
npx hardhat ignition deployments --network sepolia
npx hardhat ignition status <deployment-id> --network sepolia
```

Treasury and harvest governance notes:

- Yield recipient updates are timelock-gated once `setYieldRecipientTimelock` is configured.
- `setYieldRecipient` is executed by timelock operations, not by direct vault-admin calls.
- `harvestYieldFromStrategy` is vault-admin-gated, blocked while paused, and enforces `minReceived`.
- Native yield-recipient payout (wrapped-native harvest branch) reverts with `NativeTransferFailed` if yield recipient cannot receive ETH.
- `YieldHarvested.principalToken` is always the principal token key (for wrapped-native harvest it remains wrapped-native token).
- Harvest transactions also emit `PrincipalDeallocatedFromStrategy` telemetry for strategy unwind; indexers should treat
  `PrincipalDeallocatedFromStrategy.received` (vault-side balance delta) and `YieldHarvested.received` (yield-recipient-side net receipt)
  as distinct metrics.

### Ops Docs

- Incident/deployment runbook: `docs/operations-runbook.md`
