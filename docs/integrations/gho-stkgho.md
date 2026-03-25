---
title: "GHO / stkGHO Integration"
updated: "2026-04-02"
audience: "integrators, reviewers, operators"
purpose: "document the implemented GSM -> GHO -> stkGHO strategy and current V2 policy behavior"
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

- `totalExposure()` reports gross vault-token-equivalent exposure
- exposure is a vault-token accounting view, not a guaranteed net exit quote
- treasury reimbursement is intentionally excluded from exposure and bridge-liquidity planning

Supported lane assumption:

- this strategy is intended for stablecoin lanes such as USDC and USDT
- the lane is treated as `FixedRoute`
- the strategy owns the full fixed path and does not accept arbitrary route input
- explicit fee is inferred by the vault from realized execution
- any explicit exit cost is represented by the GSM exit fee on `GHO -> vault-token`
- tracked reimbursement is a vault policy decision, not an implicit strategy behavior
- the vault owns the lane's tracked principal ledger

## Exit Model

- the strategy exposes one exit surface: `withdraw(amount)`
- normal deallocation uses that surface to recover tracked principal
- harvest uses the same surface to realize residual value
- the strategy itself never requests reimbursement
- positive stkGHO share-price drift is treated as residual value only at the vault layer

## Reimbursement Model

The strategy does not decide whether reimbursement happens.

The vault's V2 policy does.

Current intended GHO lane policy:

- `entryCapBps = 0`
- `exitCapBps = 7`
- `policyActive = true`

Tracked entry and exit reimbursement uses a second same-transaction treasury step:

1. the strategy deallocation returns only strategy-path proceeds to the vault
2. the vault requests reimbursement directly from the current `yieldRecipient` treasury
3. the treasury pays the vault directly in the vault token
4. the vault measures that second inflow separately and emits explicit reimbursement telemetry

This means:

- `VaultTokenDeallocatedFromStrategy` reports `received`, `fee`, and `loss`
- `FeeReimbursed` on the treasury reports the reimbursed fee and remaining budget
- harvests stay reimbursement-free
- tracked-flow reimbursement is automatic only when treasury configuration is correct
- reimbursement is exact-or-revert for non-zero expected fees on a reimbursing path
- incident response should not rely on reimbursement as bridgeable liquidity

## Treasury Expectations

`yieldRecipient` is not a passive sink in this integration.

It must be a reimbursement-capable treasury contract that:

- implements the withdrawal-fee treasury marker interface
- authorizes the vault via `setAuthorizedVault(vault, true)` before reimbursement is used
- holds the vault-token budget for the relevant strategy lane
- is configured per `(strategy, token, direction)` with `enabled` and `remainingBudget`
- returns exact reimbursement or `0`, never a partial payment

## Operational Notes

- `initialize()` does not force a treasury policy; the vault turns policy on later
- before tracked reimbursement is relied on in production, admin must rotate `yieldRecipient` to a compatible treasury contract if needed
- treasury rotation only checks marker support, native payout support, and vault authorization; lane tuple config remains operator-managed
- paused/admin deallocation still follow the normal V2 exit policy
- harvest bypasses reimbursement
- normal vault deallocation uses `withdraw(amount)` against tracked outstanding only
- residual value stays for harvest
- GHO harvestability is based on raw residual `max(0, totalExposure - costBasis)`
- direct GHO can exist at rest as ordinary lane inventory
- if GSM mint fee ever becomes non-zero on a zero-cap entry policy, normal allocation should revert and be escalated instead of silently continuing

## Behavioral Nuances

- reimbursement is based on the actual exit fees paid by the normal V2 deallocation legs
- the strategy holds zero tracked-principal state
- loss recognition happens on `deallocateAll`, not through a separate write-down
- residual value includes:
  - unsolicited `vaultToken`, `GHO`, and `stkGHO`
  - share-price appreciation above the tracked vault-funded value
- unsolicited `vaultToken`, `GHO`, and `stkGHO` in the strategy are treated as residual value only

## Code and Test Surfaces

- Strategy implementation: [../../contracts/strategies/GsmStkGhoStrategy.sol](../../contracts/strategies/GsmStkGhoStrategy.sol)
- Vault implementation: [../../contracts/vault/GRVTL1TreasuryVault.sol](../../contracts/vault/GRVTL1TreasuryVault.sol)
- Treasury implementation: [../../contracts/governance/YieldRecipientTreasury.sol](../../contracts/governance/YieldRecipientTreasury.sol)
- Strategy tests: [../../test/unit/GsmStkGhoStrategy.test.ts](../../test/unit/GsmStkGhoStrategy.test.ts)
- Vault reimbursement tests: [../../test/unit/VaultGhoReimbursement.test.ts](../../test/unit/VaultGhoReimbursement.test.ts)

## Read Next

- [../design-decisions/07-v2-lane-policy.md](../design-decisions/07-v2-lane-policy.md)
- [../design-decisions/08-gho-fixed-route-policy.md](../design-decisions/08-gho-fixed-route-policy.md)
- [../concepts/strategy-model.md](../concepts/strategy-model.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [../concepts/v2-accounting-walkthrough.md](../concepts/v2-accounting-walkthrough.md)
