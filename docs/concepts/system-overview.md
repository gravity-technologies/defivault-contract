# System Overview

## Metadata

- Audience: contributors, auditors, operators, integrators
- Purpose: provide the stable mental model for the system
- Canonical for: terminology, subsystem responsibilities, strategy lifecycle

## System Model

The system has three primary jobs:

1. custody L1 assets in the vault,
2. allocate selected assets into approved yield strategies,
3. move liquidity from the L1 vault back to the L2 exchange through controlled bridge flows.

The implemented contracts in this repo are:

- `GRVTL1TreasuryVault`
- `NativeVaultGateway`
- `NativeBridgeGateway`
- `AaveV3Strategy`

High-level topology:

```text
External ETH sender
    |
    v
NativeVaultGateway --> GRVTL1TreasuryVault --> AaveV3Strategy --> Aave
                               |
                               v
                    BridgeHub + SharedBridge
                               ^
                               |
                    NativeBridgeGateway
```

## Component Responsibilities

### Vault

The vault is the system's policy and accounting core.

It owns:

- role-gated allocation, deallocation, harvest, and bridge actions,
- supported-token and strategy-pair configuration,
- cost basis and tracked TVL-token bookkeeping,
- pause semantics and emergency paths.

### Strategies

Strategies are vault-only adapters to external yield venues.

They are responsible for:

- pulling approved ERC20 vault tokens from the vault,
- returning vault tokens to the vault on unwind,
- reporting exact-token balances and vault-token-level exposure.

### NativeVaultGateway

This is the canonical external ETH ingress path.

It accepts ETH, wraps it into the configured wrapped-native token, and forwards the ERC20 balance to the vault so vault accounting remains token-domain based.

Integrations should use `depositToVault()` or a full-gas native `call`. Solidity stipend-based `.transfer()` and `.send()` are not supported because the receive path immediately wraps and forwards the deposit.

### NativeBridgeGateway

This is the canonical native bridge execution and failed native deposit recovery boundary.

It unwraps wrapped-native into ETH for bridge submission and re-wraps recovered ETH before sending value back into vault accounting.

## Terminology

- `vault token`: ERC20 token key used for allocation, cap, harvest, and strategy configuration.
- `supported vault token`: vault token enabled for normal risk-on operations.
- `token-strategy pair`: one `(vaultToken, strategy)` entry with its own whitelist, active flag, and cap.
- `exact token balance`: strategy-held balance for one literal ERC20 token address from `exactTokenBalance(token)`.
- `position breakdown`: diagnostic token list from `positionBreakdown(vaultToken)`.
- `receipt token`: non-vault-token component token representing the invested position, such as `aUSDT`.
- `strategy cost basis`: vault-side accounting basis for one `(vaultToken, strategy)` pair.
- `strategy exposure`: single-number vault-token exposure returned by `strategyExposure(vaultToken)` for cap and harvest math.
- `TVL token`: any exact ERC20 token the vault can report in raw token totals.
- `tracked TVL token`: token currently surfaced by `getTrackedTvlTokens()` and `trackedTvlTokenTotals()`.
- `native path`: explicit native bridge methods that use wrapped-native internally and route execution through `NativeBridgeGateway`.

## Strategy Lifecycle

Each `(vaultToken, strategy)` pair tracks both `whitelisted` and `active`.

- `whitelisted`: may receive new allocations.
- `active`: remains in the withdraw/reporting set.

These flags intentionally separate "can receive new funds" from "still has to be unwound and reported."

Lifecycle states:

1. not registered: `whitelisted = false`, `active = false`
2. normal operation: `whitelisted = true`, `active = true`
3. withdraw-only: `whitelisted = false`, `active = true`
4. removed: `whitelisted = false`, `active = false`

## Canonical Rules

- Native bridge paths are explicit. There is no `address(0)` sentinel API for bridge intent.
- Vault and strategy accounting stay in ERC20 token space.
- Raw ETH is only expected at explicit ingress, payout, unwrap, or failed-deposit-recovery boundaries.
- Design-decision docs explain why the system is shaped this way. Canonical behavior should still be traced back to this concepts layer, the architecture docs, and contract interfaces.

## Read Next

- [strategy-model.md](strategy-model.md)
- [accounting-and-tvl.md](accounting-and-tvl.md)
- [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)
- [../reference/roles-and-permissions.md](../reference/roles-and-permissions.md)
