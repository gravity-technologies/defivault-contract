# Scenario 4B: Strategy with Non-1:1 Scalar Conversion

## What This Is For
This scenario explains how to design adapters when principal-bearing exposure is not naturally 1:1 to underlying units.

Primary users:
- adapter authors for protocols with index/share conversion
- reviewers assessing conversion-risk assumptions

## When You Need This Model
Use this when strategy exposure requires conversion logic, for example:
- share-to-asset conversion (ERC4626/Morpho-like)
- index-based accrual (Compound-like)
- protocol-specific exchange-rate math

## Required Adapter Behavior
- Keep `assets(token)` exact-token and conversion-free.
- Put conversion/index logic only in `principalBearingExposure(token)`.
- Unsupported token queries:
  - `assets(token)` => empty components,
  - `principalBearingExposure(token)` => `0`.

## Most Common Flow (Day-to-Day)
1. Adapter reports components in native token units.
2. Adapter computes scalar exposure via conversion/index path.
3. Vault uses scalar for cap/harvest math only.
4. Vault never converts components itself.

## Design Notes on Conversion Source
- Conversion can come from protocol-native state (preferred).
- External oracle use is possible if protocol math requires it.
- If using oracle-like inputs, document staleness/manipulation assumptions explicitly.

## Operational Tradeoffs
- Better economic accuracy than fixed 1:1 assumptions.
- Higher complexity and higher risk of stale/misconfigured conversion inputs.
- Strong adapter tests are required around edge cases and failure modes.

## Debug Checklist
- Are `assets(token)` outputs still exact-token without conversion?
- Is scalar conversion logic deterministic and bounded?
- Are unsupported token domains non-reverting?
- Are conversion assumptions documented for operators/reviewers?
