---
title: "GHO Two-Step Reimbursement Settlement"
added: "2026-03-26"
audience: "contributors, reviewers, auditors, operators"
purpose: "explain why GHO reimbursement settles as a separate treasury step around tracked deallocation"
decision_type: "upgrade safety, accounting, strategy integration"
---

# 07 GHO Two-Step Reimbursement Settlement

## Context

The GHO lane has a real unwind fee on the `GHO -> vault-token` GSM exit.

The product requirement is:

- reimburse that explicit exit fee automatically for tracked exits,
- reimburse only in the lane vault token,
- keep harvests reimbursement-free,
- preserve upgrade compatibility with the deployed `80daded` vault.

Lane assumption for this branch:

- the supported vault-token lanes are stablecoins such as USDC and USDT,
- minting through GSM is assumed to be 1:1 into GHO for those lanes,
- the modeled unwind cost is the explicit GSM exit fee.

The obvious implementation would reimburse during the same strategy exit call and let the vault measure one combined inflow.

That approach was rejected because it breaks existing vault semantics.

## Decision

GHO reimbursement is settled in two steps inside one top-level vault transaction:

1. the strategy tracked exit returns only strategy-unwind proceeds to the vault,
2. the vault requests reimbursement directly from the current treasury,
3. the treasury pays the vault directly,
4. the vault measures that second token inflow separately and reduces cost basis by the measured reimbursement amount,
5. the vault then emits the normal deallocation event using strategy-path proceeds only.

Normal GHO flows use explicit tracked and residual entrypoints instead:

- `withdrawTracked(...)` for tracked vault-funded value only
- `withdrawResidual(...)` / `withdrawAllResidual(...)` for untracked residual value only

## Why Not Reimburse Inside One Strategy Exit

We do not reimburse inside the same strategy-exit measurement because that would silently change deployed vault behavior.

If reimbursement landed during the same exit call that returned strategy proceeds:

- the vault would lose the ability to distinguish tracked recovery from residual value,
- harvest accounting would break because `harvestableYield()` excludes reimbursement while the measured vault receipt would include it,
- partial exits could consume treasury budget without delivering reimbursement to the current withdrawal,
- unsolicited residual balances could silently make tracked exits whole and then still trigger treasury reimbursement.

The split model avoids all of those failures while keeping reimbursement automatic in the same top-level transaction.

## Consequences

- tracked exits can still reimburse automatically in one transaction,
- deallocation telemetry now reports tracked and residual receipts separately,
- harvests remain reimbursement-free,
- cost basis is only reduced when the vault actually measures reimbursement arriving,
- reimbursement telemetry is explicit through a dedicated settlement event.

## Related Nuances

Tracked-only exits:

- `withdrawTracked()` consumes tracked vault-funded value only,
- its `amount` argument is expressed in vault-token units, not gross GHO units,
- the strategy tracks vault-funded value through an internal redeemable-asset claim plus backing stkGHO shares,
- it does not use residual value to satisfy the exit,
- reimbursement therefore applies only to the actual exit fee paid by that tracked unwind.

Exact settlement:

- reimbursement is exact-or-revert for non-zero expected fees,
- the vault measures the treasury-to-vault token delta and does not trust treasury return values alone,
- a `0` reimbursement for a non-zero expected fee is treated as misconfiguration or underfunding and reverts the reimbursing exit.

Paused and defensive exits:

- paused/admin deallocation and emergency unwind still use the reimbursing tracked path on this branch,
- harvest remains the only exit path that is always reimbursement-free.

Principal-versus-yield split:

- every reimbursing exit is capped by current vault-tracked cost basis,
- if an exit request is larger than tracked cost basis, the vault performs:
  - a reimbursing tracked leg up to current cost basis, then
  - a non-reimbursing residual leg for the remaining residual-value portion.
- the strategy uses staking conversion previews to separate tracked vault-funded value from residual value even when stkGHO share price drifts,
- unsolicited `vaultToken`, `GHO`, and `stkGHO` cannot be consumed by the reimbursing tracked leg,
- residual value may still increase total vault-side proceeds on oversized exits, but it must not reduce tracked cost basis outside the capped reimbursement path.

## Related Docs

- [08-gho-yield-recipient-treasury-boundary.md](08-gho-yield-recipient-treasury-boundary.md)
- [02-measured-vault-delta-cost-basis.md](02-measured-vault-delta-cost-basis.md)
- [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md)
