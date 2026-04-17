---
title: "GHO / sGHO Integration"
updated: "2026-04-14"
audience: "integrators, reviewers, operators"
purpose: "document the implemented GSM -> GHO -> sGHO strategy and current V2 policy behavior"
implemented_surfaces:
  - "contracts/strategies/SGHOStrategy.sol"
  - "contracts/governance/YieldRecipientTreasury.sol"
  - "contracts/vault/GRVTL1TreasuryVault.sol"
---

# GHO / sGHO Integration

## Scope

This page describes the implemented `SGHOStrategy` behavior in this repository.

Primary users:

- engineers integrating the sGHO strategy lane
- reviewers validating unwind and accounting assumptions
- operators configuring treasury reimbursement and yield-recipient flows

## Adapter Model

Deployment is single-lane:

- one strategy instance binds one input `vaultToken`
- the lane is `vaultToken -> GSM -> GHO -> sGHO`
- mutating calls revert on token mismatch
- the strategy integrates the live ERC4626 `sGHO` token surface directly
- exits are synchronous; there is no claim flow or cooldown flow

Reporting model:

- `exactTokenBalance(vaultToken)` reports idle underlying held by the strategy
- `exactTokenBalance(gho)` reports idle GHO held by the strategy
- `exactTokenBalance(sGho)` reports the directly held invested `sGHO` balance
- `positionBreakdown()` reports `sGHO` as the invested position plus any residual GHO or vault-token dust

Exposure model:

- `totalExposure()` reports strategy value in vault-token units
- `withdrawableExposure()` reports redeemable-now value in vault-token units
- `totalExposure()` is the economic claim view
- `withdrawableExposure()` is the operational liquidity view
- the value is before exit fees, but entry fees are not added back into it
- for this stablecoin lane, direct `GHO` and `sGHO.previewRedeem(...)` are treated as the same
  stable-value accounting unit as `vaultToken`
- reporting does not quote GHO back through the GSM; explicit exit cost is handled later on the real exit path

Supported lane assumption:

- this strategy is intended for stablecoin lanes such as USDC and USDT
- the lane is treated as `FixedRoute`
- after decimal conversion, `vaultToken`, GHO, and sGHO are treated as the same stablecoin unit
- the strategy owns the full fixed path and does not accept arbitrary route input
- explicit fee is inferred by the vault from realized execution
- any explicit exit cost is represented by the GSM exit fee on `GHO -> vault-token`
- tracked reimbursement is a vault policy decision, not an implicit strategy behavior
- the vault owns the lane's tracked principal ledger

## Entry Assumptions

On entry, the implemented route assumes:

- `vaultToken -> static aToken -> GSM sell -> GHO -> sGHO`
- the GSM underlying asset is the expected `StataToken` over the same `vaultToken`
- the GSM `GHO_TOKEN()` matches `sGHO.asset()`
- the GSM `PRICE_RATIO` is `1.0`
- the GSM sell fee is `0` at initialization
- any entry loss is therefore expected to come from rounding or dust, not a configured GSM sell fee

In plain terms, this lane assumes the Aave GSM behaves like a clean stable-value bridge from
the static token into GHO on entry.

## Failure Modes

The strategy fails closed for two different reasons:

- bad config:
  the lane is pointed at the wrong GSM, wrong wrapped asset, wrong GHO token, wrong price ratio,
  or a GSM with non-zero sell fee at initialization
- impossible quote or settlement:
  the GSM preview says it will sell or buy a shape that does not match the exact route input,
  returns zero gross output where that makes no sense, or settles worse than its own quote

These failures surface as:

- `InvalidInitializationParams`
- `InvalidGsmConfig`
- `GsmQuoteMismatch`
- `GsmSettlementMismatch`

## Exit Model

- the strategy exposes one exit surface: `withdraw(amount)`
- normal deallocation uses that surface to recover tracked principal
- harvest uses the same surface to realize residual value
- the strategy itself never requests reimbursement
- SGHO exits are fail-closed: if redeemable liquidity is insufficient, the strategy reverts instead of partially unwinding
- positive sGHO share-price drift is treated as residual value only at the vault layer

## Reimbursement Model

The strategy does not decide whether reimbursement happens.

The vault's V2 policy does.

Current intended SGHO lane policy:

- `entryCapHundredthBps = 1` (`0.01 bps`)
- `exitCapHundredthBps = 1200` (`12 bps`)
- `policyActive = true`

Tracked entry and exit reimbursement uses a second same-transaction treasury step:

1. the strategy deallocation returns only strategy-path proceeds to the vault
2. the vault requests reimbursement directly from the current `yieldRecipient` treasury
3. the treasury pays the vault directly in the vault token
4. the vault measures that second inflow separately and emits explicit reimbursement telemetry

This means:

- `VaultTokenDeallocatedFromStrategy` reports `received`, `fee`, and `loss`
- `FeeReimbursed` on the treasury reports the reimbursed token amount and recipient
- harvests stay reimbursement-free
- tracked-flow reimbursement is automatic only when treasury configuration is correct
- reimbursement is exact-or-revert for non-zero expected fees on a reimbursing path
- reimbursement covers explicit route fee only; it never fills a temporary SGHO liquidity gap
- incident response should not rely on reimbursement as bridgeable liquidity

## Treasury Expectations

`yieldRecipient` is not a passive sink in this integration.

It must be a reimbursement-capable treasury contract that:

- implements the fee reimburser marker interface
- authorizes the vault via `setAuthorizedVault(vault, true)` before reimbursement is used
- holds enough of the vault token to satisfy expected reimbursements
- returns exact reimbursement or `0`, never a partial payment
- temporary SGHO illiquidity is an operational incident, not automatic impairment recognition
- temporary SGHO illiquidity must be resolved before tracked principal exits can complete

## Operational Notes

- `initialize()` does not force a treasury policy; the vault turns policy on later
- before tracked reimbursement is relied on in production, admin must rotate `yieldRecipient` to a compatible treasury contract if needed
- treasury rotation only checks marker support, native payout support, and vault authorization; reimbursement headroom is just treasury token balance
- paused/admin deallocation still follow the normal V2 exit policy
- harvest bypasses reimbursement
- normal vault deallocation uses `withdraw(amount)` against tracked outstanding only
- residual value stays for harvest
- sGHO harvestability is based on raw residual `max(0, totalExposure - costBasis)`
- direct GHO can exist at rest as ordinary lane inventory
- if GSM mint fee ever becomes non-zero on a zero-cap entry policy, normal allocation should revert and be escalated instead of silently continuing
- if `withdrawableExposure()` drops below economically recoverable principal, `deallocateAll` reverts and leaves `costBasis` unchanged

## Behavioral Nuances

- reimbursement is based on the actual exit fees paid by the normal V2 deallocation legs
- the strategy holds zero tracked-principal state
- loss recognition happens on tracked exits when economic exposure is below requested principal
- fail-closed exits treat temporary illiquidity separately from realized impairment
- residual value includes:
  - unsolicited `vaultToken`, `GHO`, and `sGHO`
  - share-price appreciation above the tracked vault-funded value
- unsolicited `vaultToken`, `GHO`, and `sGHO` in the strategy are treated as residual value only

## Code and Test Surfaces

- Strategy implementation: [../../contracts/strategies/SGHOStrategy.sol](../../contracts/strategies/SGHOStrategy.sol)
- Vault implementation: [../../contracts/vault/GRVTL1TreasuryVault.sol](../../contracts/vault/GRVTL1TreasuryVault.sol)
- Treasury implementation: [../../contracts/governance/YieldRecipientTreasury.sol](../../contracts/governance/YieldRecipientTreasury.sol)

## Read Next

- [../design-decisions/07-v2-lane-policy.md](../design-decisions/07-v2-lane-policy.md)
- [../design-decisions/08-gho-fixed-route-policy.md](../design-decisions/08-gho-fixed-route-policy.md)
- [../concepts/strategy-model.md](../concepts/strategy-model.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [../concepts/v2-accounting-walkthrough.md](../concepts/v2-accounting-walkthrough.md)
- [./SGHO_ACCOUNTING.md](./SGHO_ACCOUNTING.md)
