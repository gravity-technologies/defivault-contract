# Scenario 4C: Generic Strategy Adapter Flow

## What This Is For

This scenario defines the rules any strategy adapter must satisfy, regardless of protocol.

Primary users:

- adapter implementers
- protocol reviewers
- backend teams integrating new strategy types

## Required Adapter Rules

- Strategy inputs are ERC20 vault tokens.
- `exactTokenBalance(token)` reports the balance for that token only.
- `positionBreakdown(vaultToken)` reports the tokens and amounts currently held for that vault token.
- `strategyExposure(token)` returns the single number used for cap and harvest math.
- `tvlTokens(vaultToken)` declares the exact ERC20 tokens the vault should keep in the tracked TVL-token set for that pair.
- Unsupported token behavior is non-reverting:
  - zero token balance,
  - empty position breakdown,
  - zero strategy exposure.

## Tracking Rules

- The vault tracks tokens from cached `tvlTokens(vaultToken)` lists plus the set of supported vault tokens.
- Receipt/share tokens can appear in `getTrackedTvlTokens()` when a strategy declares them in `tvlTokens(vaultToken)`.
- Reward/incentive tokens are ignored by tracked TVL-token registry and current cap/harvest/reporting math.

## Most Common Flow (Day-to-Day)

1. Admin whitelists strategy for a vault token.
2. Vault allocates/deallocates vault token units.
3. Vault caches `tvlTokens(vaultToken)` for tracked TVL tokens.
4. Vault reads `exactTokenBalance(token)` for per-token totals and `strategyExposure(token)` for cap and harvest logic.
5. `getTrackedTvlTokens` and `isTrackedTvlToken` read stored state only.

Examples this supports:

- Aave-like: receipt token + residual vault token.
- Index-only models: vault-token-only reporting with no separate receipt token.
- Share-vault models: share token as a TVL token alongside any residual vault token.

## Failure Behavior

- If strategy token-balance reads fail, `tokenTotals` reverts and `tokenTotalsConservative` increments `skippedStrategies`.
- If strategy breakdown reads fail, `strategyPositionBreakdown` reverts with `InvalidStrategyTokenRead`.

## Why This Is Complex

- The vault needs accurate reporting, cheap reads, and behavior that still works when one strategy misbehaves.
- Different protocols expose balances differently, but the vault interface must stay consistent.

## Debug Checklist

- Does the adapter keep token-by-token balances, breakdown output, and exposure calculation separate?
- Does the adapter return `0` or empty output for unsupported tokens instead of reverting?
- Does `positionBreakdown(vaultToken)` show the expected tokens and amounts?
- If TVL looks wrong, are callers using `exactTokenBalance` and `tokenTotals` instead of treating breakdown output as converted value?
