# Aave Integration

## Metadata

- Status: implemented in this repo
- Audience: integrators, reviewers, operators
- Purpose: document the current Aave adapter behavior and its assumptions
- Implemented surfaces: `contracts/strategies/AaveV3Strategy.sol`, `test/fork/AaveMainnetFork.test.ts`

## Scope

This page describes the implemented `AaveV3Strategy` behavior in this repository.

Primary users:

- engineers integrating the current Aave adapter
- reviewers validating Aave-specific assumptions
- operators debugging Aave-based harvest and cap decisions

## Adapter Model

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

## Code and Test Surfaces

- Strategy implementation: [../../contracts/strategies/AaveV3Strategy.sol](../../contracts/strategies/AaveV3Strategy.sol)
- Aave pool interface: [../../contracts/external/IAaveV3Pool.sol](../../contracts/external/IAaveV3Pool.sol)
- Fork coverage: [../../test/fork/AaveMainnetFork.test.ts](../../test/fork/AaveMainnetFork.test.ts)

## Read Next

- [../concepts/strategy-model.md](../concepts/strategy-model.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
