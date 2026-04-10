# Strategy Model

## Metadata

- Audience: contributors, adapter implementers, reviewers
- Purpose: define the canonical strategy adapter model for this vault
- Canonical for: adapter responsibilities, reporting surfaces, exposure patterns

## Strategy Contract Model

Strategies are vault-only adapters to external yield venues.

Each strategy must:

- accept ERC20 vault-token inputs from the vault,
- deploy those assets into an external venue,
- return vault tokens back to the vault on unwind,
- expose reporting surfaces the vault can use for exact-token totals and vault-token-level exposure.

This repo now has two strategy interfaces:

- legacy lanes use [IYieldStrategy.sol](../../contracts/interfaces/IYieldStrategy.sol)
- policy-native V2 lanes use [IYieldStrategyV2.sol](../../contracts/interfaces/IYieldStrategyV2.sol)

Use the legacy surface for already deployed lanes that must remain compatible.
Use the V2 surface for new policy-native lanes.

## Legacy And V2

Legacy `IYieldStrategy` keeps the original multi-token vault model:

- the vault passes `vaultToken` into the strategy call,
- the strategy can decide how it handles that supported token,
- the vault measures real token movement and trusts as little as possible beyond that.

V2 `IYieldStrategyV2` is stricter:

- one deployment is one lane for one `vaultToken`,
- the fund-moving surface is `allocate(amount)` and `withdraw(amount)`,
- the vault infers fees from realized balance deltas instead of calling previews,
- harvest is just a vault-side residual withdrawal, not a separate strategy surface,
- V2 strategies are trusted implementations, so the vault does not try to prove their internal route bookkeeping on-chain,
- the vault owns the authoritative principal ledger for the lane,
- but V2 entry accounting trusts strategy-reported `invested` and only uses measured vault deltas to reject impossible results,
- when a V2 lane is economically empty, final removal is an admin cleanup step, not a strict exact-token archival proof.

## Required Adapter Rules

- Strategy inputs are ERC20 vault tokens.
- `exactTokenBalance(token)` reports the balance for that token only.
- legacy adapters report lane-specific state through `positionBreakdown(vaultToken)`, `strategyExposure(vaultToken)`, and `tvlTokens(vaultToken)`.
- V2 adapters report the same concepts through single-lane `positionBreakdown()`, `totalExposure()`, and `tvlTokens()`.
- Unsupported token behavior is non-reverting:
  - zero token balance,
  - empty position breakdown,
  - zero strategy exposure.

## Reporting Model

These surfaces are intentionally separate:

- `exactTokenBalance(token)`: exact token accounting
- `positionBreakdown(...)`: diagnostic token shape
- `strategyExposure(...)`: cap and harvest exposure

Do not collapse them into one number. Exact reporting and economic exposure solve different problems.

## TVL Tracking Rules

- The vault tracks supported vault tokens directly.
- Active strategy pairs add tokens from cached `tvlTokens(vaultToken)` lists.
- Receipt or share tokens can appear in `getTrackedTvlTokens()` when a strategy declares them.
- Reward and incentive tokens are outside the current tracked-TVL and exposure model.

This lets the vault keep read paths cheap while still surfacing the relevant token set for indexers.

## Common Adapter Patterns

### 1:1 receipt-token assumption

This exists in both the legacy and V2 Aave models in this repo:

- `exactTokenBalance(aToken)` reports invested receipt-token units
- `positionBreakdown(underlying)` can show `aToken` plus residual underlying
- `strategyExposure(underlying)` uses a 1:1 assumption between receipt token and underlying

The difference is operational shape:

- `AaveV3Strategy` is the legacy adapter
- `AaveV3StrategyV2` is the policy-native single-lane `DirectWrapper` baseline

See [../integrations/aave.md](../integrations/aave.md) for the implemented examples.

### Fixed approved composite

This is the current GHO / stkGHO V2 model in this repo:

- `exactTokenBalance(stkGho)` reports directly held invested stkGHO units
- `positionBreakdown()` can show `stkGHO` plus residual `GHO` or vault-token dust
- `totalExposure()` reports strategy value in vault-token units for the lane
- `withdraw(amount)` is the only exit surface
- the vault uses the same `withdraw(amount)` surface for tracked deallocation and residual harvest
- fee caps are enforced on realized exits, not preview calls

Rules for this model:

- keep route shape fixed inside the strategy implementation,
- report strategy value in the same token units used by the vault's principal ledger,
- keep harvest on the vault-owned residual path,
- let the vault enforce fee caps on realized execution,
- keep reimbursement decisions in vault policy and treasury config, not in the strategy.

See [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md) for the implemented example.

### Non-1:1 exposure conversion

Use this model when exposure is not naturally 1:1 with the vault token, for example:

- share-to-asset conversion for ERC4626-like or Morpho-like positions
- index-based accrual for Compound-like positions
- protocol-specific exchange-rate math

Rules for this model:

- keep `exactTokenBalance(token)` as direct per-token reporting with no conversion
- keep `positionBreakdown(vaultToken)` as plain token-and-amount output
- put conversion or index math only in `strategyExposure(vaultToken)`
- keep unsupported token behavior non-reverting

Tradeoffs:

- better economic accuracy than a fixed 1:1 assumption
- higher implementation and testing complexity
- higher risk if conversion inputs are stale or misconfigured

If conversion depends on oracle-like inputs, document staleness and manipulation assumptions explicitly.

## Failure Behavior

- If exact-token reads fail, `tokenTotals(token)` reverts.
- Conservative reads such as `tokenTotalsConservative(token)` and `trackedTvlTokenTotals()` skip bad strategy reads and report `skippedStrategies`.
- Strategy adapters should keep supported read paths stable and deterministic.

## Review Checklist

- Does the adapter keep exact-token balances, breakdown output, and exposure calculation separate?
- Does it return `0` or empty output for unsupported tokens instead of reverting?
- Does `tvlTokens(vaultToken)` match the tokens the adapter intends the vault to track?
- Is exposure logic deterministic, bounded, and well-tested?
- Are conversion assumptions explicit when the model is not 1:1?

## Read Next

- [system-overview.md](system-overview.md)
- [accounting-and-tvl.md](accounting-and-tvl.md)
- [v2-strategy-brief.md](v2-strategy-brief.md)
- [v2-accounting-walkthrough.md](v2-accounting-walkthrough.md)
- [../integrations/aave.md](../integrations/aave.md)
- [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md)
