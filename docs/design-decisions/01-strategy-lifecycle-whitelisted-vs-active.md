---
title: "Strategy Lifecycle: Whitelisted vs Active"
audience: "contributors, reviewers, operators"
purpose: "explain why strategy lifecycle uses two flags instead of one"
decision_type: "state model"
---

# Strategy Lifecycle: Whitelisted vs Active

## Context

The vault needs to answer two different questions for each `(vaultToken, strategy)` pair:

- may this pair receive new allocations?
- must this pair still participate in withdraw and reporting flows?

Those questions do not always have the same answer.

## Decision

The vault tracks both:

- `whitelisted`: may receive new allocations
- `active`: remains in the withdraw and reporting set

## Alternatives Considered

Single boolean "enabled" state:

- rejected because a strategy can be de-whitelisted for new risk while still holding funds,
- rejected because incident-time and withdraw-only flows still need O(1) membership in deallocation and reporting paths.

## Consequences

- the system can enter a withdraw-only phase without pretending the strategy is fully removed,
- allocation can stop immediately while unwind and reporting continue,
- deallocation and TVL/reporting logic can still include the pair until exposure is drained.

## Lifecycle States

1. not registered: `whitelisted = false`, `active = false`
2. normal operation: `whitelisted = true`, `active = true`
3. withdraw-only: `whitelisted = false`, `active = true`
4. removed: `whitelisted = false`, `active = false`

## Operational Implications

- de-whitelisting a strategy does not imply that it disappears from reporting or unwind paths immediately,
- operators should expect withdraw-only pairs to remain visible until exposure is drained,
- docs and tooling should distinguish "cannot allocate" from "no longer exists."

## Related Docs

- [../concepts/system-overview.md](../concepts/system-overview.md)
- [../reference/roles-and-permissions.md](../reference/roles-and-permissions.md)
- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
