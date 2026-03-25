---
title: "GHO Yield-Recipient Treasury Boundary"
added: "2026-03-26"
audience: "contributors, reviewers, auditors, operators"
purpose: "explain why `yieldRecipient` must be a treasury contract for GHO reimbursement and what remains manual"
decision_type: "trust boundary, operations, treasury policy"
---

# 08 GHO Yield-Recipient Treasury Boundary

## Context

This upgrade intentionally changes the operational meaning of `yieldRecipient`.

Before the GHO reimbursement path, `yieldRecipient` could be treated as a passive sink for harvested proceeds.

With GHO reimbursement:

- the GHO strategy needs a treasury source for principal-token fee reimbursement,
- that treasury source must be the current `yieldRecipient`,
- operators still need a single destination for harvested proceeds.

## Decision

`yieldRecipient` is the treasury boundary for both harvested proceeds and GHO reimbursement.

That means:

- `yieldRecipient` must be a smart contract implementing the reimbursement treasury interface,
- the treasury must authorize the vault explicitly before reimbursing exits are used,
- `setYieldRecipient` rejects non-compatible contracts,
- treasury policy is configured per `(strategy, token)` with `enabled` and `remainingBudget`,
- reimbursement is exact-or-zero and paid directly to the vault.

This keeps one treasury destination, but makes the trust boundary explicit.

Because the deployed vault lineage already exists, this branch keeps the operational migration in governance:

- `initialize()` does not enforce treasury compatibility,
- admin must rotate `yieldRecipient` to a compatible treasury contract before reimbursing exits are used,
- after that rotation, `setYieldRecipient` continues to enforce treasury compatibility for future changes.

## Why Not Make Treasury Selection Fully Dynamic

We do not let the strategy or vault choose arbitrary reimbursement treasuries per exit because that would:

- widen the fund-drain surface,
- complicate operator reasoning,
- make upgrade configuration harder to audit,
- weaken the meaning of `yieldRecipient` across harvest and reimbursement flows.

We also do not auto-refill budgets on-chain.

Budget replenishment remains governance-controlled because automatic refill would let hot-path strategy flows expand treasury exposure without a human funding decision.

## Consequences

Automatic on-chain behavior:

- tracked exit unwinds,
- reimbursement is requested in the same transaction,
- treasury pays the vault directly,
- vault measures reimbursement and adjusts cost basis,
- residual value remains on the explicit non-reimbursing residual path and does not change the treasury request.

Manual governance behavior:

- choosing the treasury contract,
- authorizing the vault on that treasury,
- funding that treasury,
- enabling or disabling reimbursement per `(strategy, token)`,
- updating reimbursement budgets,
- rotating treasury contracts if operational policy changes.

## Operational Nuances

Misconfiguration handling:

- a non-compatible `yieldRecipient` is rejected on `setYieldRecipient`,
- admin must perform the one-time post-upgrade migration from passive sink to treasury contract before reimbursement is relied on,
- underfunded, disabled, or short-paying reimbursement will now block reimbursing exits because the vault expects an exact measured top-up.

Current liveness tradeoff:

- this branch chooses exact reimbursement over best-effort fallback,
- normal tracked exits, paused/admin exits, and emergency unwind tracked legs all depend on treasury correctness,
- harvest remains live because it only uses the residual path and never calls reimbursement.

## Related Docs

- [07-gho-two-step-reimbursement-settlement.md](07-gho-two-step-reimbursement-settlement.md)
- [../operations/runbook.md](../operations/runbook.md)
- [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md)
