---
title: "GHO Fixed Route Policy"
added: "2026-04-02"
audience: "contributors, reviewers, auditors, operators"
purpose: "record the intended V2 policy shape for the GSM -> GHO -> sGHO lane"
decision_type: "strategy policy, treasury policy, liveness"
---

# 08 GHO Fixed Route Policy

## Context

The SGHO lane is not a direct wrapper. It is a fixed multi-step path:

- `vaultToken -> GSM -> GHO`
- `GHO -> sGHO`
- exits reverse that path

That makes it the main V2 lane where the new lane-shape policy matters.

The product requirements for this lane are:

- allow the lane because the route shape is fixed and explicit,
- keep harvest non-reimbursing,
- reimburse tracked-flow protocol fees through treasury,
- use tight per-direction fee caps,
- prefer failing normal liveness over silently accepting an over-cap conversion.

## Decision

`SGHOStrategy` is treated as `FixedRoute`.

The strategy itself only exposes the fixed lane. It does not accept arbitrary routing input.

The intended vault policy for the current SGHO lane is:

- `entryCapHundredthBps = 1` (`0.01 bps`)
- `exitCapHundredthBps = 1200` (`12 bps`)
- `policyActive = true`

Operational meaning:

- only tiny entry dust within the `0.01 bps` cap is reimbursable on allocation,
- tracked exit reimbursement is allowed only for the explicit exit fee and only within the `12 bps` cap,
- harvest uses the same strategy exit surface but never requests reimbursement,
- incident-time exits use the same fee-cap and reimbursement semantics as normal tracked exits.
- the vault owns the lane's tracked principal ledger; the strategy holds no tracked-principal state.
- if the lane takes a real impairment, governance recognizes that loss through `deallocateAll`.
- final removal is reserved for economically empty cleanup, not for proving every exact token balance is literally zero.

The treasury boundary is simple:

- the vault must be explicitly authorized on the treasury before reimbursement is relied on,
- reimbursement succeeds only if the treasury already holds enough of the reimbursed token,
- entry and exit eligibility still remain distinct at the vault policy layer.

## Why Entry Cap Stays At Zero

For GHO entry:

- the acceptable cap is zero,
- any non-zero mint fee means the route no longer satisfies the current operating policy,
- the right response is to stop normal allocation and escalate the venue issue.

## Consequences

- GHO is allowed only as a fixed-route lane.
- Entry liveness is intentionally brittle by policy: a non-zero mint fee reverts normal allocation.
- Tracked entry and exit reimbursement depend on treasury configuration being correct.
- Harvest remains explicit residual realization, not a generic "anything profitable" unwind.
- Incident runbooks must not treat expected reimbursement as bridgeable liquidity.

## Related Docs

- [07-v2-lane-policy.md](07-v2-lane-policy.md)
- [../integrations/gho-sgho.md](../integrations/gho-sgho.md)
- [../concepts/v2-accounting-walkthrough.md](../concepts/v2-accounting-walkthrough.md)
- [../operations/vault-upgrades-and-v2-policy.md](../operations/vault-upgrades-and-v2-policy.md)
