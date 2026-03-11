# Scenario 3: TVL Reporting with Vault and Component Tokens

## What This Is For

This scenario explains why TVL is reported one token at a time and how the tracked-token list works.

Primary users:

- developers building dashboards/indexers
- operators validating TVL discrepancies

## Most Common Flow (Day-to-Day)

Goal: query totals for one token at a time.

Example state:

- Vault idle: `USDT = 200`, `aUSDT = 0`
- Strategy A reports: `aUSDT = 1000`, residual `USDT = 20`
- Strategy B reports: `aUSDT = 500`, residual `USDT = 10`

Results:

- `tokenTotals(USDT)` => `200 + 20 + 10 = 230`
- `tokenTotals(aUSDT)` => `0 + 1000 + 500 = 1500`

Key point:

- USDT and aUSDT are never converted into each other on-chain.

## Ad-hoc / Incident Flows

### 1) Revert-on-failure vs skip-on-failure reads

- `tokenTotals(token)` reverts if a strategy read fails.
- `tokenTotalsConservative(token)` and `tokenTotalsBatch` skip bad reads and increment `skippedStrategies`.

### 2) How tracked tokens are added and removed

- Supported vault tokens are tracked directly.
- Active strategy pairs add whatever exact ERC20 tokens they declare in cached `tvlTokens(vaultToken)` lists.
- `getTrackedTvlTokens` and `isTrackedTvlToken` read stored state only.
- `refreshStrategyTvlTokens(vaultToken, strategy)` updates the cached token list after an adapter changes which tokens it reports.

### 3) Strategies that report more than one token

- You can still inspect a multi-token breakdown through `strategyPositionBreakdown(vaultToken, strategy)`.
- TVL-token discovery follows cached `tvlTokens(vaultToken)`, not live breakdown reads.

### 4) Read failures that leave tracking in place

- Conservative behavior can keep tokens tracked when strategy reads fail.
- Admin override control: `setTrackedTvlTokenOverride(token, enabled, forceTrack)`.

## Why This Is Complex

- Reporting needs correct per-token balances.
- Operations still need usable reads even when one adapter misbehaves.
- Tracking needs cheap reads, so token discovery happens on write paths instead of every view call.

These goals pull in different directions, so the system exposes both revert-on-failure and skip-on-failure paths.

## Debug Checklist

- Are you calling `tokenTotals` or `tokenTotalsConservative`?
- Are component tokens being confused with off-chain value conversions?
- Is tracked-token membership stale because support or strategy state changed without the expected write call or token-list refresh?
- Did strategy read failures pin tracking conservatively or require an explicit `refreshStrategyTvlTokens` once the adapter recovered?
