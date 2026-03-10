# Scenario 3: TVL Reporting with Root and Component Tokens

## What This Is For

This scenario explains why TVL/reporting is exact-token and how tracked-token registry interacts with reporting.

Primary users:

- developers building dashboards/indexers
- operators validating TVL discrepancies

## Most Common Flow (Day-to-Day)

Goal: query strict exact totals by token.

Example state:

- Vault idle: `USDT = 200`, `aUSDT = 0`
- Strategy A reports: `aUSDT = 1000`, residual `USDT = 20`
- Strategy B reports: `aUSDT = 500`, residual `USDT = 10`

Results:

- `totalExactAssets(USDT)` => `200 + 20 + 10 = 230`
- `totalExactAssets(aUSDT)` => `0 + 1000 + 500 = 1500`

Key point:

- USDT and aUSDT are never converted into each other on-chain.

## Ad-hoc / Incident Flows

### 1) Strict vs degraded read surfaces

- `totalExactAssets(token)` is strict and reverts on invalid strategy reads.
- `totalExactAssetsStatus(token)` and `totalAssetsBatch` skip bad reads and increment `skippedStrategies`.

### 2) Tracked token lifecycle

- Root token tracking comes from support/exposure signals.
- Registry scope is principal tokens only.
- `getTrackedPrincipalTokens` / `isTrackedPrincipalToken` are storage-backed reads only.

### 3) Unsupported multi-non-principal shape

- Non-principal breakdown shape can still be inspected through `strategyPositionBreakdown(principalToken, strategy)`.
- It does not change tracked-principal discovery.

### 4) Read-failure pinning

- Conservative behavior can keep tokens tracked when strategy reads fail.
- Break-glass admin control: `setTrackedPrincipalOverride(token, enabled, forceTrack)`.

## Why This Is Complex

- Reporting wants strict correctness and denomination purity.
- Operations want liveness even when adapters misbehave.
- Registry wants cheap reads, so discovery moves to write hooks.

These goals conflict, so the system provides strict and degraded paths.

## Debug Checklist

- Are you querying strict (`totalAssets`) or degraded (`totalAssetsStatus`) surface?
- Are component tokens being confused with valuation-converted totals?
- Is tracked-principal membership stale because support/exposure changed without the expected write path?
- Did strategy read failures pin root tracking conservatively?
