---
title: "V2 Lane Policy"
added: "2026-04-02"
audience: "contributors, reviewers, auditors, operators"
purpose: "explain why V2 strategies are policy-native single-lane adapters and how the vault enforces lane-shape policy"
decision_type: "strategy interface, policy enforcement, accounting"
---

# 07 V2 Lane Policy

## Context

The legacy strategy surface in this repo was built for generic vault-token adapters:

- one vault can manage many strategy types through `IYieldStrategy`,
- the vault measures actual token movement and uses exposure reads for cap and harvest math,
- strategy integrations are responsible for their own venue-specific behavior.

That model is still needed for deployed legacy lanes such as `AaveV3Strategy`.

It is not strict enough for the new treasury policy.

The new policy is structural, not price-oracle-based:

- no generic router or operator-supplied path is allowed,
- fee caps must be enforced per lane and per direction,
- harvest must stay non-reimbursing,
- if a configured cap is exceeded, normal liveness should break rather than silently continue.

## Decision

New lanes use `IYieldStrategyV2`, not the legacy `IYieldStrategy` surface.

The V2 model is intentionally different:

- each strategy deployment is a single-lane adapter bound to one `vaultToken`,
- each policy-sensitive path uses one shared `withdraw(amount)` exit surface,
- fees are inferred from realized balance deltas in vault-token units,
- the vault owns per-lane policy config through `StrategyPolicyConfig`,
- the vault activates the policy per `(vaultToken, strategy)` pair with `policyActive`,
- harvest uses the same strategy withdrawal surface and never requests reimbursement,
- there is no separate emergency unwind surface; incident-time exits use the same fee and reimbursement rules as normal tracked exits.
- V2 strategies are trusted implementations, so the vault does not treat their internal route bookkeeping as an adversarial input.
- the vault owns the authoritative tracked principal ledger.
- V2 entry accounting trusts strategy-reported `invested`; vault-side balance deltas remain sanity checks, not the V2 source of truth for principal.
- final lane removal is an admin cleanup action for an economically empty lane, not a strict exact-token archival proof.
- if a lane is impaired, governance recognizes that loss during `deallocateAll` rather than through a separate write-down path.

The policy does not use a runtime "close to 1:1" price check.

## Why Not Use A Price-Ratio Guard

A runtime ratio check was rejected because it solves the wrong problem.

The policy concern is not short-term price drift. It is route shape and operator discretion.

A ratio guard would still leave us with the hard questions:

- which venue or path is allowed?
- which wrappers count as acceptable?
- what reference price should the vault trust?
- how much deviation is acceptable during stress?

That would add oracle and interpretation risk to a rule that is better expressed as immutable strategy shape plus explicit vault policy.

## Why Break V2 Instead Of Extending Legacy

No V2 strategy was deployed when this change landed.

That let us redesign V2 around the actual policy instead of carrying compatibility shims:

- legacy `IYieldStrategy` remains for deployed lanes,
- V2 ABI is allowed to change,
- strategy implementers must provide the lane-shape, gross-exposure, and entry/exit reporting the vault needs,
- the vault can enforce caps and reimbursement from realized execution without keeping mirrored tracked state in the strategy.

## Consequences

- V2 lanes are stricter than legacy lanes by construction.
- Strategy implementations must keep their reported units consistent with vault-token accounting.
- Vault policy activation is a separate admin decision from lane whitelisting.
- Raw residual yield is `max(0, totalExposure - costBasis)`.
- Incident-time operator flows are explicit: choose which lanes to deallocate, then use the normal bridge path.

## Related Docs

- [08-gho-fixed-route-policy.md](08-gho-fixed-route-policy.md)
- [09-legacy-vault-upgrade-path.md](09-legacy-vault-upgrade-path.md)
- [../concepts/v2-strategy-brief.md](../concepts/v2-strategy-brief.md)
- [../concepts/strategy-model.md](../concepts/strategy-model.md)
- [../operations/vault-upgrades-and-v2-policy.md](../operations/vault-upgrades-and-v2-policy.md)
