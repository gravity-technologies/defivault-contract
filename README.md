# GRVT L1 DefiVault Contract

This repository contains the **GRVT L1 DefiVault contract** and its Hardhat-based development environment, using the native Node.js test runner (`node:test`) and `viem` for Ethereum interactions.

In simple terms, this contract helps put GRVT TVL to work by allocating funds into established DeFi venues such as Aave, so the vault can generate on-chain yield in a structured way.

## Project Overview

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
                         |       GRVTDeFiVault       |
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
  |  Rebalancer/Ops     +-----------------------> GRVTDeFiVault
  | (REBALANCER/PAUSER) |
  +---------------------+

```

Native ingress path via NativeWrap (`NativeToWrappedIngress`) into canonical wrapped-native vault balances.

```text
  +-------------------------+   external ETH   +---------------------------+  wrapped-native transfer
  | Native ETH Sender/User  +----------------->+  NativeToWrappedIngress   +-------------------------> GRVTDeFiVault
  +-------------------------+                  |     ("NativeWrap")        |
                                               +---------------------------+
```

### Fund-Moving Policy Matrix

| Function                    | Required caller                         | Blocked by pause | Requires `token.supported` |
| --------------------------- | --------------------------------------- | ---------------- | -------------------------- |
| `allocateToStrategy`        | `ALLOCATOR_ROLE`                        | Yes              | Yes                        |
| `deallocateFromStrategy`    | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No               | No                         |
| `deallocateAllFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No               | No                         |
| `rebalanceToL2`             | `REBALANCER_ROLE`                       | Yes              | Yes                        |
| `emergencySendToL2`         | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No               | No                         |

### Terminology

- **Boundary token key**: token argument accepted by external APIs.
  Example: `rebalanceToL2(address(0), amount)` uses native-intent boundary key.
- **Native token sentinel**: `address(0)` value used to express native ETH intent.
  Example: `rebalanceToL2(address(0), ...)` means native bridge intent.
- **Canonical token key**: internal normalized token key used for storage/accounting.
  Example: boundary `address(0)` canonicalizes to `WETH`.
- **Token-strategy binding**: one `(token, strategy)` pair with independent lifecycle and cap.
  Example: `(USDT, AaveUsdtStrategy)` is one binding with its own permission state.
- **TokenAmountComponent**: one exact-token line item returned by `strategy.assets(token)`.
  Example: `{ token: aUSDT, amount: 100e6 }`.
- **Tracked token**: root token included in `getTrackedTokens()` for TVL ingestion.
  Example: tracked set includes canonical roots such as `USDT` and `WETH`.

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
totalAssets(token) = idleAssets(token) + sum(component.amount where component.token == token across active strategies)
```

Where:

- `idleAssets(token)` is the vault's direct ERC20 balance.
- `strategy.assets(token)` returns exact-token components; components may be underlying or non-root position-token units.
- The vault never converts amounts across token denominations while reporting.

The vault maintains a token registry for TVL discovery:

- `getTrackedTokens()` returns the current token set that should be tracked for TVL.
- `isTrackedToken(token)` checks if a token is currently in that set.
- Registry scope is root tokens only (canonical storage keys).
- Root tokens remain tracked while they still have exposure, even if `token.supported` is disabled.
- A root token is removed from tracking only when unsupported and fully unwound.
- Tracker sync happens on vault write paths (for example `setTokenConfig`, strategy whitelist changes, allocate/deallocate, rebalance/emergency sends).
- Read paths (`getTrackedTokens`/`isTrackedToken`) are storage-backed and do not call `strategy.assets(...)`.
- Component tokens are not auto-registered in this discovery list.
- Exact-token component reporting remains available through `totalAssets*` scans over global active strategies.

### How 3rd-Party Trackers Should Compute TVL

For accurate on-chain TVL ingestion:

1. Read tracked token list:
   - `tokens = getTrackedTokens()`
2. Read batch totals:
   - `statuses = totalAssetsBatch(tokens)`
3. Interpret each token row:
   - `statuses[i].total` is the raw token amount for `tokens[i]`.
   - `statuses[i].skippedStrategies == 0` means no strategy read failures for that token.
   - `statuses[i].skippedStrategies > 0` means total is a conservative lower bound (one or more strategies could not be read safely).
4. (Optional) For diagnostics, inspect:
   - `getTokenStrategies(token)` for token-keyed active entries.
   - `strategyAssets(token, strategy)` for any active strategy when you need per-strategy component details.

Notes:

- The contract does not provide cross-token aggregation or pricing.
- Any USD TVL metric should be computed off-chain by applying external price feeds to raw per-token totals.
- For non-root component tokens (for example receipt tokens), callers query `totalAssets(componentToken)` directly.

### Normal Yield Flow (Allocate / Deallocate)

```text
[ALLOCATOR role]
      |
      v
GRVTDeFiVault.allocateToStrategy(token, strategy, amount)
      |
      +--> checks: token supported, strategy whitelisted, cap, pause
      +--> token approve(strategy)
      +--> strategy.allocate(...)

[ALLOCATOR or VAULT_ADMIN]
      |
      v
GRVTDeFiVault.deallocateFromStrategy(...)
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
GRVTDeFiVault.rebalanceToL2(token, amount)
      |
      +--> checks: paused? no, token supported, bridge config valid
      +--> enforces: l2ExchangeRecipient fixed at initialization (no admin setter)
      +--> requires msg.value == 0
      +--> if token intent is ETH (`address(0)`), unwraps WETH and bridges native branch
      +--> rejects direct WETH bridge-out for non-native branch
      +--> mints base token for BridgeHub mintValue
      +--> calls bridgeHub.requestL2TransactionTwoBridges(...)
      |
      v
BridgeHub dispatches shared bridge deposit and emits L2 tx hash metadata
```

Note:

- External rebalance calls are ETH-free (`msg.value` must be `0`).
- Bridge execution cost is funded via minted BaseToken (`mintValue`).
- For native-intent sends, vault unwraps WETH and forwards ETH value to BridgeHub second-bridge leg.
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
GRVTDeFiVault.emergencySendToL2(token, amount)
      |
      +--> allowed while paused
      +--> callable even if token support has been disabled
      +--> pulls liquidity from active strategies (including withdraw-only de-whitelisted entries)
      +--> vault uses measured balance deltas per unwind step
      +--> requires msg.value == 0
      +--> mints base token and submits TwoBridges request
```

### NativeWrap Ingress Contract (`NativeToWrappedIngress`)

`NativeToWrappedIngress` is the canonical external ETH ingress adapter (sometimes referred to as "NativeWrap").

Purpose:

- Accept externally sourced native ETH.
- Wrap ETH into the configured wrapped-native ERC20 (for example WETH).
- Forward wrapped-native tokens directly to the vault.
- Keep the vault's investment/strategy accounting in canonical ERC20 domain.

Deployment wiring:

- Constructor: `NativeToWrappedIngress(wrappedNativeToken, vault)`.
- Deployment reverts unless both addresses are non-zero contract addresses.

Runtime behavior:

- `ingress()` (payable):
  - requires `msg.value > 0`,
  - calls `wrappedNativeToken.deposit{value: msg.value}()`,
  - transfers wrapped-native tokens to `vault`,
  - emits `NativeIngressProcessed(sender, amount)`.
- `receive()` (payable): same behavior as `ingress()`.
- `fallback()` (payable): always reverts (calldata-bearing sends are rejected).

Operational notes:

- The ingress contract is designed not to retain persistent ETH or wrapped-native balances in normal flow.
- Direct ETH sends to the vault are restricted by vault-side sender checks; planned external ETH ingress should route through this contract.

### Core Config (Initializer)

- `initialize(admin, bridgeHub, baseToken, l2ChainId, l2ExchangeRecipient, wrappedNativeToken)` sets role admins and core vault config.
- `bridgeHub`, `baseToken`, and `l2ChainId` define the L1 -> L2 bridge execution context.
- `l2ExchangeRecipient` is fixed at initialization (no admin setter exposed here).
- `wrappedNativeToken` is the canonical internal token key for native exposure accounting.
- Native sweep scaffolding is restricted to admin and sends only to treasury (treasury defaults to `admin`).

## Interface Reporting Model

### Native Boundary and Canonical Token Rules

- Write paths that express native ETH intent use `NATIVE_TOKEN_SENTINEL = address(0)`.
- Internal accounting keys and read/reporting surfaces use canonical ERC20 addresses.
- Native exposure is represented as wrapped native token on read surfaces.
- `allocateToStrategy` does not implicitly wrap native ETH and requires canonical idle funds.
- Native ingress is restricted: direct ETH sends from non-wrapper senders revert; `NativeToWrappedIngress` is the canonical external ETH ingress path.

### Token-Separated Strategy Reporting

- `IYieldStrategy.assets(token)` returns `StrategyAssetBreakdown` with exact-token components only.
- Component amounts remain in each component token's native units; no cross-token conversion is done in reporting.
- Unsupported token queries return an empty component array.
- `totalAssets(token)` / status variants scan global active strategies, so component-token queries (for example `aUSDT`) are supported even when strategy registration is keyed by a different underlying token.
- `IL1DefiVault.totalAssets(token)` returns strict exact-token totals and reverts on invalid strategy reads.
- `IL1DefiVault.totalAssetsStatus(token)` and batch status variants skip invalid strategies and report `skippedStrategies`.
- Non-underlying component token queries (for example receipt tokens) are valid exact-token queries.

### Harvest and Cap Scalar Path

- Harvest and cap logic are based on `IYieldStrategy.principalBearingExposure(token)`.
- This scalar path is separate from reporting components and may use strategy-specific conversion policies.
- Unsupported token queries for `principalBearingExposure(token)` return `0`.
- Current accounting/reporting scope excludes reward and incentive tokens.

## Protocol-Agnostic Adapter Guidance

The strategy interface is protocol-agnostic. Adapters must unify principal-bearing exposure while preserving exact-token reporting:

- Aave V3 style rebasing receipt token:
  - implemented in `AaveV3Strategy` in this repo.
  - components can include `aUSDT` as invested principal and `USDT` residual when queried in USDT domain.
  - scalar example: `principalBearingExposure(USDT) = aUSDT + USDT`, using assumption `1 aUSDT = 1 USDT` (scalar path only).
  - `deallocate`/`deallocateAll` sweep residual strategy-held underlying to vault to avoid dust-lock exposure.
  - unsupported scalar domains return `0` (non-reverting).
- Compound III style index-based accounting:
  - components remain exact token units only (typically base token domain).
  - non-underlying receipt-token reporting may be empty where accounting is purely index-based.
  - scalar is derived from principal plus index accrual in base-token domain.
- Morpho/ERC4626 share-vault style accounting:
  - components can include vault share token invested principal plus underlying residual.
  - scalar is derived by share-to-asset conversion in underlying domain (`convertToAssets` style).

These examples are theoretical adapter patterns; this scope does not add new Compound or Morpho strategy contracts.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npm run test
```
