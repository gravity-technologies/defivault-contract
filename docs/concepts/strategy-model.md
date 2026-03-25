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

The vault interface for this model is [IYieldStrategy.sol](../../contracts/interfaces/IYieldStrategy.sol).

## Required Adapter Rules

- Strategy inputs are ERC20 vault tokens.
- `exactTokenBalance(token)` reports the balance for that token only.
- `positionBreakdown(vaultToken)` reports the tokens and amounts currently held for that vault token.
- `strategyExposure(vaultToken)` returns the single number used for cap and harvest math.
- `tvlTokens(vaultToken)` declares the exact ERC20 tokens the vault should keep in the tracked TVL-token set for that pair.
- Unsupported token behavior is non-reverting:
  - zero token balance,
  - empty position breakdown,
  - zero strategy exposure.

## Reporting Model

These surfaces are intentionally separate:

- `exactTokenBalance(token)`: exact token accounting
- `positionBreakdown(vaultToken)`: diagnostic token shape
- `strategyExposure(vaultToken)`: cap and harvest exposure

Do not collapse them into one number. Exact reporting and economic exposure solve different problems.

## TVL Tracking Rules

- The vault tracks supported vault tokens directly.
- Active strategy pairs add tokens from cached `tvlTokens(vaultToken)` lists.
- Receipt or share tokens can appear in `getTrackedTvlTokens()` when a strategy declares them.
- Reward and incentive tokens are outside the current tracked-TVL and exposure model.

This lets the vault keep read paths cheap while still surfacing the relevant token set for indexers.

## Common Adapter Patterns

### 1:1 receipt-token assumption

This is the current Aave model in this repo:

- `exactTokenBalance(aToken)` reports invested receipt-token units
- `positionBreakdown(underlying)` can show `aToken` plus residual underlying
- `strategyExposure(underlying)` uses a 1:1 assumption between receipt token and underlying

See [../integrations/aave.md](../integrations/aave.md) for the implemented example.

### Reimbursing tracked-exit strategy

This is the current GHO / stkGHO model in this repo:

- `exactTokenBalance(stkGho)` reports directly held invested stkGHO units
- `positionBreakdown()` can show `stkGHO` plus residual `GHO` or vault-token dust
- `strategyExposure()` reports net redeemable vault-token exposure after:
  - converting stkGHO shares into GHO assets with the staking adapter preview, then
  - previewing the GSM exit fee
- `withdrawTracked()` is the V2 tracked path used for reimbursing tracked exits

Rules for this model:

- keep reimbursement-specific behavior on the V2 tracked/residual surface,
- track vault-funded value through an internal asset claim and backing shares when the invested asset can appreciate without minting extra shares,
- keep harvest on the plain non-reimbursing path,
- for the current GHO lane, assume stablecoin inputs such as USDC and USDT that mint 1:1 into GHO through GSM,
- let the vault measure reimbursement separately from the strategy-path deallocation receipt.

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
- [../integrations/aave.md](../integrations/aave.md)
- [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md)
