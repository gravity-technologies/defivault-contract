---
title: "GHO / stkGHO Integration"
updated: "2026-03-27"
audience: "integrators, reviewers, operators"
purpose: "document the implemented GSM -> GHO -> stkGHO strategy and reimbursement behavior"
implemented_surfaces:
  - "contracts/strategies/GsmStkGhoStrategy.sol"
  - "contracts/governance/YieldRecipientTreasury.sol"
  - "contracts/vault/GRVTL1TreasuryVault.sol"
---

# GHO / stkGHO Integration

## Scope

This page describes the implemented `GsmStkGhoStrategy` behavior in this repository.

Primary users:

- engineers integrating the stkGHO strategy lane
- reviewers validating reimbursement and unwind assumptions
- operators configuring treasury reimbursement and yield-recipient flows

## Adapter Model

Deployment is single-lane:

- one strategy instance binds one input `vaultToken`
- the lane is `vaultToken -> GSM -> GHO -> stkGHO`
- mutating calls revert on token mismatch

Reporting model:

- `exactTokenBalance(vaultToken)` reports idle underlying held by the strategy
- `exactTokenBalance(gho)` reports idle GHO held by the strategy
- `exactTokenBalance(stkGho)` reports the directly held invested stkGHO balance
- `positionBreakdown()` reports stkGHO as the invested position plus any residual GHO / vault-token dust

Exposure model:

- `strategyExposure()` reports net redeemable `vaultToken`
- exposure uses the current staking conversion preview plus the current GSM exit preview
- treasury reimbursement is intentionally excluded

Supported lane assumption:

- this strategy is intended for stablecoin lanes such as USDC and USDT
- minting through GSM is assumed to be 1:1 into GHO for those lanes
- any explicit exit cost is represented by the GSM exit fee rather than by a discounted mint

## Exit Paths

Generic exit path:

Tracked exit path:

- the strategy exposes single-lane tracked entrypoints for reimbursement-capable exits
- `withdrawTracked(trackedAmount)` unwinds tracked vault-funded value only
- `trackedAmount` is expressed in `vaultToken` units and is tracked value to consume, not a net-output target
- the strategy returns the net vault-token proceeds from that tracked unwind plus the exact exit fee paid
- residual value is never consumed by the tracked exit path
- if share-price rounding produces excess redeemed GHO or vault-token output, that excess stays on the residual path

Residual exit path:

- `withdrawResidual(amount)` realizes only untracked residual value
- `withdrawAllResidual()` realizes all remaining untracked residual value
- both paths are always non-reimbursing
- harvest and GHO oversize/emergency residual legs use these explicit residual exits
- positive stkGHO share-price drift is treated as residual value and is harvestable through this path

## Reimbursement Model

Reimbursement uses a two-step same-transaction flow:

1. the strategy tracked exit returns only strategy-path proceeds to the vault
2. the vault requests reimbursement directly from the current `yieldRecipient` treasury
3. the treasury pays the vault directly in the vault token
4. the vault measures that second inflow separately and reduces strategy cost basis by the measured reimbursement

This means:

- `VaultTokenDeallocatedFromStrategy` now reports `trackedReceived` and `residualReceived` separately
- `StrategyWithdrawalFeeReimbursementSettled` reports `reportedFee`, `cappedFee`, and `reimbursed`
- harvests stay reimbursement-free
- reimbursement is automatic on configured tracked exits
- reimbursement is exact-or-revert for non-zero expected fees
- if treasury is disabled, unfunded, incompatible, or short-pays, reimbursing exits revert
- cost basis is reduced only by measured tracked recovery plus measured capped reimbursement

## Treasury Expectations

`yieldRecipient` is not a passive sink in this integration.

It must be a reimbursement-capable treasury contract that:

- implements the withdrawal-fee treasury marker interface
- authorizes the vault via `setAuthorizedVault(vault, true)` before reimbursement is used
- holds the vault-token budget for the relevant strategy lane
- is configured per `(strategy, token)` with `enabled` and `remainingBudget`
- returns exact reimbursement or `0`, never a partial payment

## Operational Notes

- `initialize()` does not enforce treasury compatibility on this branch
- before reimbursement is relied on in production, admin must rotate `yieldRecipient` to a compatible treasury contract
- paused/admin deallocation and emergency bridge unwind paths still reimburse
- harvest remains the only strategy exit path that bypasses reimbursement
- reimbursing exits are split by current tracked amount outstanding:
  - the tracked leg uses `withdrawTracked`
  - any excess or purely untracked value uses the residual-only path
- GHO harvestability is based on explicit residual exposure, not on `strategyExposure - costBasis`
- the strategy restakes idle GHO whenever it mutates, so GHO should be zero at rest absent unsolicited transfers

## Behavioral Nuances

- reimbursement is based on the actual exit fee paid by `withdrawTracked`
- the strategy tracks vault-funded value through two internal ledgers:
  - a redeemable-asset claim used to size exits correctly
  - stkGHO shares backing that tracked value
- residual value includes:
  - unsolicited `vaultToken`, `GHO`, and `stkGHO`
  - share-price appreciation above the tracked vault-funded value
- unsolicited `vaultToken`, `GHO`, and `stkGHO` in the strategy are treated as residual value only
- full or oversized exits reimburse only the tracked leg up to current vault-tracked cost basis; yield unwind is not reimbursed
- residual value can increase total vault-side proceeds on oversized exits, but it must not reduce tracked cost basis outside the capped reimbursement path

## Code and Test Surfaces

- Strategy implementation: [../../contracts/strategies/GsmStkGhoStrategy.sol](../../contracts/strategies/GsmStkGhoStrategy.sol)
- Vault implementation: [../../contracts/vault/GRVTL1TreasuryVault.sol](../../contracts/vault/GRVTL1TreasuryVault.sol)
- Treasury implementation: [../../contracts/governance/YieldRecipientTreasury.sol](../../contracts/governance/YieldRecipientTreasury.sol)
- Strategy tests: [../../test/unit/GsmStkGhoStrategy.test.ts](../../test/unit/GsmStkGhoStrategy.test.ts)
- Vault reimbursement tests: [../../test/unit/VaultGhoReimbursement.test.ts](../../test/unit/VaultGhoReimbursement.test.ts)

## Read Next

- [../design-decisions/07-gho-two-step-reimbursement-settlement.md](../design-decisions/07-gho-two-step-reimbursement-settlement.md)
- [../design-decisions/08-gho-yield-recipient-treasury-boundary.md](../design-decisions/08-gho-yield-recipient-treasury-boundary.md)
- [../concepts/strategy-model.md](../concepts/strategy-model.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
