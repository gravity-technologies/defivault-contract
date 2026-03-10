# Scenario 4B: Strategy with Non-1:1 Exposure Conversion

## What This Is For

This scenario explains how to design adapters when strategy exposure is not naturally 1:1 with the vault token.

Primary users:

- adapter authors for protocols with share or index conversion
- reviewers assessing conversion assumptions

## When You Need This Model

Use this when strategy exposure requires conversion logic, for example:

- share-to-asset conversion (ERC4626/Morpho-like)
- index-based accrual (Compound-like)
- protocol-specific exchange-rate math

## Required Adapter Behavior

- Keep `exactTokenBalance(token)` as a direct per-token balance with no conversion.
- Keep `positionBreakdown(vaultToken)` as a list of tokens and amounts with no conversion.
- Put conversion or index logic only in `strategyExposure(token)`.
- Unsupported token queries:
  - `exactTokenBalance(token)` => `0`,
  - `positionBreakdown(vaultToken)` => empty components,
  - `strategyExposure(token)` => `0`.

## Most Common Flow (Day-to-Day)

1. Adapter reports token balances in each token's own units.
2. Adapter reports exact-token balances without conversion.
3. Adapter computes strategy exposure using share conversion, index math, or similar logic.
4. Vault uses that exposure value for cap/harvest math only.
5. Vault never converts reporting components itself.

## Design Notes on Conversion Source

- Conversion can come from protocol state (preferred).
- External oracle use is possible if protocol math requires it.
- If using oracle-like inputs, document staleness/manipulation assumptions explicitly.

## Operational Tradeoffs

- Better economic accuracy than a fixed 1:1 assumption.
- Higher complexity and higher risk of stale or misconfigured conversion inputs.
- Strong adapter tests are required around edge cases and failure modes.

## Debug Checklist

- Are `exactTokenBalance(token)` outputs still exact-token without conversion?
- Does `positionBreakdown(vaultToken)` stay as a plain token-and-amount report?
- Is the exposure conversion logic deterministic and bounded?
- Are unsupported token queries non-reverting?
- Are conversion assumptions documented for operators/reviewers?
