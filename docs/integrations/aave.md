# Aave Integration

## Metadata

- Status: implemented in this repo
- Audience: integrators, reviewers, operators
- Purpose: document the legacy and V2 Aave adapter behavior and their assumptions
- Implemented surfaces: `contracts/strategies/AaveV3Strategy.sol`, `contracts/strategies/AaveV3StrategyV2.sol`, `test/fork/AaveMainnetFork.test.ts`

## Scope

This page describes both implemented Aave adapters in this repository:

- legacy `AaveV3Strategy`
- V2 `AaveV3StrategyV2`

Primary users:

- engineers integrating the current Aave adapters
- reviewers validating Aave-specific assumptions
- operators debugging Aave-based harvest and cap decisions

## Legacy Adapter: `AaveV3Strategy`

Deployment is single-market:

- one strategy instance binds one `(underlying, aToken, aavePool)` tuple
- mutating calls revert on token mismatch

Reporting model:

- `exactTokenBalance(underlying)` reports residual underlying only
- `exactTokenBalance(aToken)` reports invested aToken balance only
- `positionBreakdown(underlying)` reports:
  - `aToken` as `InvestedPosition` when non-zero
  - `underlying` as `UninvestedToken` when non-zero
- unsupported exact-token and position queries return `0` or empty components

Exposure model:

- `strategyExposure(underlying) = aTokenBalance + underlyingResidual`
- this uses an explicit 1:1 assumption between `aToken` and underlying for exposure math
- unsupported token queries return `0`

## Normal Flow

1. Vault allocates underlying to the Aave strategy.
2. Strategy supplies to Aave and holds a rebasing aToken position.
3. Vault reads `strategyExposure(underlying)` for cap and harvest decisions.
4. Vault deallocates underlying when needed.
5. Strategy sweeps residual underlying to the vault after withdraw to avoid dust-lock exposure.

## Why This Fits

- reporting remains exact-token and conversion-free
- exposure logic stays cheap and deterministic
- the current market assumptions are simple enough for this model

## Risks and Implications

- if `aToken` diverges economically from a 1:1 relation with the underlying, exposure-based decisions can drift
- exact token movement and exact-token reporting remain correct even if exposure math becomes economically inaccurate

## V2 Adapter: `AaveV3StrategyV2`

The V2 Aave lane keeps the same venue assumption but changes the interface shape.

It is:

- a single-lane strategy bound to one `vaultToken`
- classified as `DirectWrapper`
- zero-fee in the intended venue model
- exposed through `allocate(amount)`, `withdraw(amount)`, and `totalExposure()`
- the vault owns the authoritative principal ledger for the lane
- V2 entry accounting trusts strategy-reported `invested`, while vault-side balance changes only reject impossible results

Operationally this is the baseline V2 lane:

- recommended vault policy is `0` bps entry cap and `0` bps exit cap
- tracked entry and exit reimbursement comes from treasury configuration, not per-lane booleans
- residual exposure is ordinary Aave yield above tracked principal
- normal `deallocate*` calls withdraw tracked principal
- residual Aave yield stays on the harvest path
- if the lane is impaired, `deallocateAll` is the loss-recognition path

Migration note:

- do not in-place upgrade a deployed legacy `AaveV3Strategy` into V2
- upgrade the vault, then deploy a fresh `AaveV3StrategyV2` lane and move capital over operationally

## Code and Test Surfaces

- Strategy implementation: [../../contracts/strategies/AaveV3Strategy.sol](../../contracts/strategies/AaveV3Strategy.sol)
- V2 strategy implementation: [../../contracts/strategies/AaveV3StrategyV2.sol](../../contracts/strategies/AaveV3StrategyV2.sol)
- Aave pool interface: [../../contracts/external/IAaveV3Pool.sol](../../contracts/external/IAaveV3Pool.sol)
- Fork coverage: [../../test/fork/AaveMainnetFork.test.ts](../../test/fork/AaveMainnetFork.test.ts)

## Read Next

- [../concepts/strategy-model.md](../concepts/strategy-model.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
