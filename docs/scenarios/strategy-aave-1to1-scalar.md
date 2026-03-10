# Scenario 4A: Aave Strategy (1:1 Exposure Assumption)

## What This Is For

This scenario explains the exact behavior of `AaveV3Strategy` in this repo.

Primary users:

- engineers integrating the current Aave adapter
- reviewers validating Aave-specific assumptions
- operators debugging Aave-based harvest/cap decisions

## Adapter Model (Implemented Today)

Deployment is single-market:

- one strategy instance binds one `(underlying, aToken, aavePool)` tuple.
- mutating calls revert on token mismatch.

Reporting model:

- `exactTokenBalance(underlying)` reports residual underlying only.
- `exactTokenBalance(aToken)` reports invested aToken balance only.
- `positionBreakdown(underlying)` reports:
  - `aToken` as `InvestedPosition` (if non-zero),
  - `underlying` as `UninvestedToken` (if non-zero).
- unsupported exact-token / position queries return `0` / empty components.

Exposure model:

- `strategyExposure(underlying) = aTokenBalance + underlyingResidual`.
- explicit adapter assumption: `1 aToken == 1 underlying` for the exposure calculation.
- unsupported token queries return `0`.

## Most Common Flow (Day-to-Day)

1. Vault allocates underlying to Aave strategy.
2. Strategy supplies into Aave and holds rebasing aToken position.
3. Vault reads `strategyExposure(underlying)` for cap and harvest decisions.
4. Vault deallocates underlying when needed.
5. Strategy sweeps residual underlying to vault after withdraw to prevent dust-lock exposure.

## Why This Is Acceptable Here

- Vault reporting remains exact-token and conversion-free.
- Exposure calculation is intentionally simplified for this market.
- Operational logic stays deterministic and cheap.

## Risks and Implications

- If aToken value diverges from 1:1 with the underlying token, exposure-based decisions can drift.
- Actual token movement and per-token reporting remain correct even if the exposure calculation becomes economically inaccurate.

## Debug Checklist

- Is caller querying `strategyExposure` for the underlying token (not the aToken)?
- Does `positionBreakdown(underlying)` show the expected aToken + residual split?
- Do exact-token queries return residual underlying vs invested aToken on the correct token addresses?
- Is residual dust being swept after deallocate/deallocateAll?
- If cap/harvest seems off, check whether 1:1 assumption still holds economically.
