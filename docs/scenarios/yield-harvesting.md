# Scenario 2: Yield Harvesting

## What This Is For

This scenario explains how `harvestYieldFromStrategy` works, what it guarantees, and why it has multiple guards.

Primary users:

- vault operators running harvest jobs
- engineers indexing harvest/deallocation telemetry

## Most Common Flow (Day-to-Day)

Goal: extract yield only, keep principal stable.

Example:

- stored principal = `1000`
- scalar exposure = `1120`
- harvestable = `120`

Call:

- `harvestYieldFromStrategy(token, strategy, amount=80, minReceived=79)`

Flow:

1. Vault checks strategy is withdrawable and `amount <= harvestable`.
2. Vault deallocates from strategy (vault-side measured delta).
3. Vault pays treasury (ERC20 transfer or wrapped-native unwrap + ETH payout).
4. Vault enforces treasury-side slippage: `received >= minReceived`.
5. Vault emits `PrincipalDeallocatedFromStrategy` and `YieldHarvested`.
6. Vault re-syncs tracked-token state post-payout.

## Ad-hoc / Incident Flows

### 1) Slippage guard failures

- If treasury net receipt is below `minReceived`, harvest reverts with `SlippageExceeded`.
- For wrapped-native branch, comparison is against treasury ETH balance delta.

### 2) Strategy over-withdraw behavior

- Vault pre-reads `maxYield`.
- If measured withdrawn amount exceeds pre-read bound, harvest reverts with `YieldNotAvailable`.

### 3) Loss-side write-down on deallocation

- Harvest itself does not directly decrement principal.
- But post-unwind exposure check can clamp principal down and emit `StrategyPrincipalWrittenDown`.

### 4) Exposure read failure after unwind

- Vault does not revert unwind just because post-read fails.
- Emits `StrategyPrincipalWriteDownSkipped`.

### 5) Sequential harvests

- Multiple harvests are expected.
- Principal stays stable across yield-only harvests unless write-down conditions are met.

## Why This Is Complex

Harvest mixes three domains:

- strategy-side scalar exposure math
- vault-side measured balance deltas
- treasury-side net receipt/slippage enforcement

Those domains intentionally differ to resist malformed strategy returns and fee-on-transfer/token quirks.

## Debug Checklist

- Was `token` canonical ERC20 principal token key (not `address(0)`)?
- Is strategy in withdrawable lifecycle state?
- Did `minReceived` match treasury-side net receipt expectations?
- Are indexers handling both `PrincipalDeallocatedFromStrategy` and `YieldHarvested` in same tx?
- If principal moved unexpectedly, check write-down events.
