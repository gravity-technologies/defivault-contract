# Accounting and TVL

## Metadata

- Audience: contributors, auditors, indexers, operators
- Purpose: explain the vault's accounting model and reporting surfaces
- Canonical for: cost basis, exposure, exact-token reporting, tracked TVL-token rules

## Accounting Model

The vault does not do cross-token valuation on-chain.

Reporting is token-by-token:

```text
tokenTotals(token) = idleAssets(token) + sum(strategy exact-token balances for token)
```

That means:

- `USDT` totals stay in `USDT` units,
- `aUSDT` totals stay in `aUSDT` units,
- the vault never converts one token into another during reporting.

## Three Separate Surfaces

The system intentionally keeps these surfaces separate:

- `exactTokenBalance(token)`: exact balance for one literal token address
- `positionBreakdown(vaultToken)`: diagnostic token list for a vault-token position
- `strategyExposure(vaultToken)`: single-number vault-token exposure used for cap and harvest logic

This split matters because exact reporting and economic exposure are not always the same thing.

Example:

- `exactTokenBalance(aUSDT)` reports `aUSDT` units
- `positionBreakdown(USDT)` can include `aUSDT` plus residual `USDT`
- `strategyExposure(USDT)` returns the one number the vault uses for cap and harvest math

## Cost Basis By Strategy Family

Legacy and V2 now use different entry accounting rules.

Legacy lanes:

- `allocateVaultTokenToStrategy(vaultToken, strategy, amount)` increases cost basis by the vault's measured net token outflow during allocation,
- this keeps deposit friction and under-spend behavior out of future harvestable yield.

Example:

- requested allocation: `100`
- strategy receives: `99`
- stored cost basis: `100`
- later exposure: `120`
- harvestable yield: `20`, not `21`

V2 lanes:

- `allocate(amount)` returns strategy-reported `invested`,
- the vault still measures `spent = balanceBefore - balanceAfter`,
- but V2 cost basis increases by `invested`, not `spent`,
- entry fee is inferred as `spent - invested` and reimbursed by treasury on tracked flows.

Example:

- requested allocation: `100`
- vault-side spent: `100`
- strategy-reported invested: `99`
- stored V2 cost basis: `99`
- treasury reimburses: `1`

This is a conscious trust tradeoff. V2 treats governance-controlled strategies as trusted for the lower bound on deployed principal. The vault still rejects impossible shapes such as `invested > spent`, but it does not independently prove that `invested` is not too low.

That means:

- legacy stays "measured delta first",
- V2 is simpler and aligns with unconditional tracked-flow reimbursement,
- the vault remains authoritative for the stored principal number,
- but V2 entry accounting depends on honest strategy reporting.

## Tracked TVL Tokens

The vault maintains a tracked token registry so indexers can discover the current token set without calling strategy reporting functions on every read.

Tracked-token scope includes:

- supported vault tokens,
- tokens declared by cached `strategy.tvlTokens(vaultToken)` lists for active pairs,
- admin overrides from `setTrackedTvlTokenOverride(token, enabled, forceTrack)`.

Important rules:

- read paths such as `getTrackedTvlTokens()` and `isTrackedTvlToken(token)` are storage-backed,
- tracked-token sync happens on vault write paths,
- `refreshStrategyTvlTokens(vaultToken, strategy)` explicitly refreshes one cached strategy token list,
- exact-token totals remain available even outside the tracked registry through `tokenTotals(token)` and `tokenTotalsConservative(token)`.

## Strict vs Conservative Reads

- `tokenTotals(token)` is strict and reverts if a strategy read is invalid.
- `tokenTotalsConservative(token)` skips bad reads and reports `skippedStrategies`.
- `tokenTotalsBatch(tokens)` is the batch conservative variant.
- `trackedTvlTokenTotals()` returns the tracked token list plus conservative totals in one call.

Use strict reads when correctness of every strategy read matters. Use conservative reads for operator dashboards and indexers that must stay available through partial strategy failures.

## Indexer Guidance

Preferred snapshot flow:

1. call `trackedTvlTokenTotals()`
2. treat each `statuses[i].total` as the raw token amount for `tokens[i]`
3. treat `statuses[i].skippedStrategies > 0` as a lower-bound signal

For deeper diagnostics:

- use `getSupportedVaultTokens()` to inspect vault-token coverage,
- use `getVaultTokenStrategies(vaultToken)` to inspect active strategy pairs,
- use `strategyPositionBreakdown(vaultToken, strategy)` when you need the per-strategy token shape.

## Scope Boundaries

- On-chain docs in this repo describe raw token amounts, not USD TVL.
- Reward and incentive tokens are currently outside the accounting model unless a future implementation explicitly brings them into scope.
- Design-decision docs capture why the accounting model was chosen; canonical accounting rules live here and in the interfaces.

## Read Next

- [system-overview.md](system-overview.md)
- [strategy-model.md](strategy-model.md)
- [v2-accounting-walkthrough.md](v2-accounting-walkthrough.md)
- [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)
- [../design-decisions/03-raw-token-tvl-accounting.md](../design-decisions/03-raw-token-tvl-accounting.md)
- [../design-decisions/04-cached-tracked-tvl-token-registry.md](../design-decisions/04-cached-tracked-tvl-token-registry.md)
