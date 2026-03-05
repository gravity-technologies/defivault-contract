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
- Non-principal token tracking comes from write-time component discovery.
- `getTrackedTokens` / `isTrackedToken` are storage-backed reads only.

### 3) Unsupported multi-non-principal shape

- If strategy reports multiple distinct non-principal tokens in one domain:
  - vault emits `StrategyPositionTokenShapeUnsupported`
  - vault tracks first non-principal token for registry sync
  - flow stays non-reverting

### 4) Read-failure pinning

- Conservative behavior can keep tokens tracked when strategy reads fail.
- Break-glass admin control: `setRootTrackingOverride(token, enabled, forceTrack)`.

## Why This Is Complex

- Reporting wants strict correctness and denomination purity.
- Operations want liveness even when adapters misbehave.
- Registry wants cheap reads, so discovery moves to write hooks.

These goals conflict, so the system provides strict and degraded paths.

## Debug Checklist

- Are you querying strict (`totalAssets`) or degraded (`totalAssetsStatus`) surface?
- Are component tokens being confused with valuation-converted totals?
- Is tracked-token membership stale due to missing write hook since strategy shape change?
- Did strategy read failures pin root tracking conservatively?
