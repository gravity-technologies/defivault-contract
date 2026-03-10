# Scenario 2: Yield Harvesting

## What This Is For

This scenario explains how `harvestYieldFromStrategy` works, what it guarantees, and why it has multiple guards.

Primary users:

- vault operators running harvest jobs
- engineers indexing harvest and deallocation events

## Most Common Flow (Day-to-Day)

Goal: extract yield only, keep cost basis stable.

Why cost basis uses the requested amount:

- `strategyCostBasis` follows requested allocation amount, not realized strategy receipt.
- This keeps deposit-time friction classified as loss/cost instead of future harvestable yield.
- See the README terminology section for the worked example.

Example:

- stored cost basis = `1000`
- exposure value = `1120`
- harvestable = `120`

Call:

- `harvestYieldFromStrategy(token, strategy, amount=80, minReceived=79)`

Flow:

1. Vault checks strategy is withdrawable and `amount <= harvestable`.
2. Vault deallocates from the strategy and measures how much actually came back.
3. Vault pays treasury (ERC20 transfer or wrapped-native unwrap + ETH payout).
4. Vault checks the treasury-side slippage rule: `received >= minReceived`.
5. Vault emits `VaultTokenDeallocatedFromStrategy` and `YieldHarvested`.
6. Vault refreshes tracked-token state after payout.

## Ad-hoc / Incident Flows

### 1) Slippage guard failures

- If treasury net receipt is below `minReceived`, harvest reverts with `SlippageExceeded`.
- For wrapped-native branch, comparison is against treasury ETH balance delta.

### 2) Strategy over-withdraw behavior

- Vault pre-reads `maxYield`.
- If measured withdrawn amount exceeds pre-read bound, harvest reverts with `YieldNotAvailable`.

### 3) Sequential harvests

- Multiple harvests are expected.
- Cost basis stays stable across yield-only harvests.

## Why This Is Complex

Harvest combines three different measurements:

- the strategy's exposure calculation
- the vault's measured balance change
- the treasury's final received amount

These measurements are intentionally separate so the vault does not rely on a strategy's own return values and can handle fee-on-transfer behavior.

The requested-allocation cost-basis rule is part of that design. It prevents deposit-time friction from being reclassified as profit on a later harvest.

## Debug Checklist

- Was `token` the ERC20 vault token (not `address(0)`)?
- Is strategy in withdrawable lifecycle state?
- Did `minReceived` match the treasury's expected received amount?
- Are indexers handling both `VaultTokenDeallocatedFromStrategy` and `YieldHarvested` in the same transaction?
- If cost basis moved unexpectedly, inspect allocation/deallocation flows and tracked cost basis updates.
