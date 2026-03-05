# Scenario 4C: Generic Strategy Adapter Flow

## What This Is For

This scenario defines the vault-level contract any strategy adapter must satisfy, regardless of protocol.

Primary users:

- adapter implementers
- protocol reviewers
- backend teams integrating new strategy types

## Vault-Adapter Contract (Must Hold)

- Strategy domain is canonical ERC20 token keys.
- `assets(token)` is reporting-only, exact-token components.
- `principalBearingExposure(token)` is scalar-only for cap/harvest math.
- Unsupported token behavior is non-reverting:
  - empty assets components,
  - zero principal-bearing exposure.

## Tracking Assumptions (Current Simplified Model)

- For each `(tokenDomain, strategy)`, vault tracking assumes at most one non-principal receipt token.
- Residual underlying (`component.token == tokenDomain`) is root exposure, not separate component-tracked token.
- Reward/incentive tokens are ignored by tracked-token registry and current cap/harvest/reporting math.

## Most Common Flow (Day-to-Day)

1. Admin whitelists strategy for a principal token domain.
2. Vault allocates/deallocates principal token units.
3. Write hooks sync tracked-token membership from strategy assets shape.
4. Read paths (`getTrackedTokens`, `isTrackedToken`) remain storage-backed.

Example shapes this supports:

- Aave-like: non-principal receipt token + residual principal token.
- Index-only models: principal-token-only reporting with no receipt token component.
- Share-vault models: share token as non-principal component and principal residual when present.

## Edge Behavior (Liveness-First)

- If strategy assets read fails during sync, vault preserves previous receipt-token registration.
- If strategy returns multiple distinct non-principal tokens, vault treats shape as unsupported for sync:
  - emits telemetry,
  - preserves liveness,
  - uses the first discovered non-principal token as registration candidate.

## Why This Is Complex

- The vault must balance strict reporting correctness, cheap reads, and operational liveness.
- Different protocols expose different position shapes, but vault interfaces must stay uniform.

## Debug Checklist

- Does adapter keep assets/scalar concerns separated?
- Does adapter honor unsupported-token non-reverting behavior?
- Does component shape fit single-receipt tracking assumption?
- If tracking seems stale, did a write hook execute after strategy state changed?
