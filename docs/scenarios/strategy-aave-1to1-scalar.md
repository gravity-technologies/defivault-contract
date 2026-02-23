# Scenario 4A: Aave Strategy (1:1 Scalar Assumption)

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
- `assets(underlying)` reports:
  - `aToken` as `InvestedPrincipal` (if non-zero),
  - `underlying` as `ResidualUnderlying` (if non-zero).
- `assets(aToken)` reports `aToken` only.
- unsupported token queries return empty components.

Scalar model:
- `principalBearingExposure(underlying) = aTokenBalance + underlyingResidual`.
- explicit adapter assumption: `1 aToken == 1 underlying` for scalar math.
- unsupported token queries return `0`.

## Most Common Flow (Day-to-Day)
1. Vault allocates underlying to Aave strategy.
2. Strategy supplies into Aave and holds rebasing aToken position.
3. Vault reads `principalBearingExposure(underlying)` for cap/harvest decisions.
4. Vault deallocates underlying when needed.
5. Strategy sweeps residual underlying to vault after withdraw to prevent dust-lock exposure.

## Why This Is Acceptable Here
- Vault reporting remains exact-token and conversion-free.
- Scalar path is intentionally simplified for this market.
- Operational logic stays deterministic and cheap.

## Risks and Implications
- If aToken economic value diverges from 1:1 with underlying, scalar-based decisions can drift.
- Actual token movement and exact-token reporting remain correct even when scalar economics drift.

## Debug Checklist
- Is caller querying `principalBearingExposure` in underlying domain (not aToken domain)?
- Do `assets(underlying)` components show expected aToken + residual split?
- Is residual dust being swept after deallocate/deallocateAll?
- If cap/harvest seems off, check whether 1:1 assumption still holds economically.
