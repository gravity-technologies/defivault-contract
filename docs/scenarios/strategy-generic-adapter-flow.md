# Scenario 4C: Generic Strategy Adapter Flow

## What This Is For

This scenario defines the vault-level contract any strategy adapter must satisfy, regardless of protocol.

Primary users:

- adapter implementers
- protocol reviewers
- backend teams integrating new strategy types

## Vault-Adapter Contract (Must Hold)

- Strategy domain is canonical ERC20 token keys.
- `exactTokenBalance(token)` is exact-token accounting only.
- `positionBreakdown(principalToken)` is diagnostic principal-domain reporting only.
- `principalBearingExposure(token)` is scalar-only for cap/harvest math.
- Unsupported token behavior is non-reverting:
  - zero exact-token balance,
  - empty principal-domain breakdown,
  - zero principal-bearing exposure.

## Tracking Assumptions

- Tracked-token discovery is principal-token only.
- Non-principal receipt/share tokens are not auto-discovered in `getTrackedPrincipalTokens()`.
- Reward/incentive tokens are ignored by tracked-principal registry and current cap/harvest/reporting math.

## Most Common Flow (Day-to-Day)

1. Admin whitelists strategy for a principal token domain.
2. Vault allocates/deallocates principal token units.
3. Vault reads `exactTokenBalance(token)` for exact-token aggregation and `principalBearingExposure(token)` for cap/harvest logic.
4. Read paths (`getTrackedPrincipalTokens`, `isTrackedPrincipalToken`) remain storage-backed.

Example shapes this supports:

- Aave-like: non-principal receipt token + residual principal token.
- Index-only models: principal-token-only reporting with no receipt token component.
- Share-vault models: share token as non-principal component and principal residual when present.

## Edge Behavior (Liveness-First)

- If strategy exact-token reads fail, strict totals revert and degraded totals increment `skippedStrategies`.
- If strategy principal-domain breakdown reads fail, `strategyPositionBreakdown` normalizes the failure to `InvalidStrategyAssetsRead`.

## Why This Is Complex

- The vault must balance strict reporting correctness, cheap reads, and operational liveness.
- Different protocols expose different position shapes, but vault interfaces must stay uniform.

## Debug Checklist

- Does adapter keep exact-token, breakdown, and scalar concerns separated?
- Does adapter honor unsupported-token non-reverting behavior on all three read surfaces?
- Does `positionBreakdown(principalToken)` reflect the expected principal-domain shape?
- If TVL looks wrong, are callers using `exactTokenBalance`/`totalExactAssets` rather than interpreting breakdown components as converted value?
