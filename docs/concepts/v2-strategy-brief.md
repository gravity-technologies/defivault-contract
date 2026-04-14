# V2 Strategy Brief

## Metadata

- Audience: reviewers, auditors, contributors, operators
- Purpose: summarize the move from legacy strategy adapters to V2 lane-native strategies
- Canonical for: high-level V2 review orientation

This brief explains the V2 model at review depth. It is intentionally shorter than the accounting walkthrough.

For detailed examples, see [v2-accounting-walkthrough.md](v2-accounting-walkthrough.md).

## Short Version

V2 changes the strategy model from "generic adapter behind one vault" to "single-purpose lane adapter with vault-owned accounting."

The design rules are:

- one strategy deployment is one lane
- one lane is bound to one `vaultToken`
- the strategy executes the route
- the vault owns the principal ledger
- the vault infers fees from realized token movement
- reimbursement is a treasury policy, not strategy behavior
- migration is operational: drain legacy lanes, deploy fresh V2 lanes, move funds over

## Assumptions

The V2 model assumes:

- V2 strategies are governance-controlled deployments, not arbitrary third-party plug-ins.
- Migration happens lane by lane. Existing legacy positions should be unwound under legacy rules before capital moves into fresh V2 lanes.
- Tracked-flow reimbursement is available only when the treasury is configured and funded for that lane.
- Harvest belongs to the protocol, so harvest fees are not reimbursed.
- Loss is recognized during a real unwind through `deallocateAll`, not through a separate write-down flow.

## Why V2 Exists

The legacy strategy surface is broad by design:

- one strategy can serve multiple vault tokens
- the vault passes `vaultToken` into strategy calls
- the interface has to support several adapter shapes
- the vault relies more heavily on measured token deltas for entry accounting

That was useful for generic integrations, but it is too loose for policy-sensitive lanes where route shape, fee caps, reimbursement, and harvest behavior need to be explicit.

V2 narrows the model:

- `vaultToken` is fixed in strategy state
- `allocate(amount)` and `withdraw(amount)` are the fund-moving surfaces
- `totalExposure()` reports strategy value in vault-token units
- the strategy does not expose a separate full-exit primitive
- the vault uses the same withdrawal surface for tracked deallocation and residual harvest

See [strategy-model.md](strategy-model.md) for the canonical adapter model.

## Accounting Boundary

In V2, the strategy:

- accepts funds
- executes the route
- reports balances and exposure
- returns funds on withdrawal

The vault:

- stores `costBasis`
- decides what is principal and what is residual yield
- infers fees from realized balance changes
- handles reimbursement

The key accounting rules are:

- `totalExposure()` is reported in vault-token units, before exit fees and without adding back entry fees.
- On allocation, the strategy returns `invested`.
- For V2 lanes, the vault increases `costBasis` by `invested`.
- On exit, the vault measures what it actually received.
- Fee is inferred from the gap between the requested value and what the vault actually received.
- Residual yield is `max(0, totalExposure - costBasis)`.

This creates a deliberate trust tradeoff. V2 entry accounting uses strategy-reported `invested`, while vault-side balance checks only reject impossible results. That is acceptable only because V2 lanes are governance-controlled implementations.

For the worked USDT/GHO examples, see [v2-accounting-walkthrough.md](v2-accounting-walkthrough.md).

## SGHO Lane Example

The SGHO lane is the clearest V2 example because its route is fixed:

```text
vaultToken -> GSM -> GHO -> sGHO
```

The SGHO strategy is narrow by design:

- route shape is fixed in the implementation
- operator-provided paths are not accepted
- exposure is reported back in vault-token terms
- the strategy does not decide what portion is principal or yield
- share-price appreciation and leftover route inventory become harvestable only when vault-side exposure exceeds cost basis

See [../integrations/gho-sgho.md](../integrations/gho-sgho.md) for the implemented SGHO lane behavior.

## Reimbursement Boundary

Reimbursement is handled outside the strategy.

The strategy returns what the route actually produced. If tracked principal should be protected from route fees, the vault asks the treasury to reimburse the shortfall in a separate step.

The flow is:

1. strategy executes the route
2. vault measures the result
3. vault computes the fee from the shortfall
4. vault checks the configured fee cap
5. treasury reimburses the vault if the lane is configured and the fee is allowed

This keeps route proceeds and treasury support separate.

That treasury step covers realized route fee only. It does not convert temporary strategy illiquidity into reimbursable value.

Harvest is different. Harvest belongs to the protocol, so harvest fees are not reimbursed.

## Loss Handling

For V2 lanes, loss is recognized on tracked exits when economic exposure is below the requested principal.

For a bounded exit, the vault computes:

```text
economicRecoverable = min(requestedAmount, totalExposure)
withdrawable = min(requestedAmount, withdrawableExposure)
loss = requestedAmount - economicRecoverable
```

For a full unwind, the vault computes:

```text
economicRecoverable = min(costBasis, totalExposure)
withdrawable = min(costBasis, withdrawableExposure)
loss = costBasis - economicRecoverable
```

If `withdrawable < economicRecoverable`, the exit reverts and leaves cost basis unchanged.

If liquidity is available, it withdraws economically recoverable principal and recognizes the loss. A full unwind then zeroes cost basis.

This keeps impairment recognition tied to a real unwind instead of a separate bookkeeping ceremony.

## Beacon Proxy Note

V2 lanes are deployed through beacon proxies:

- one implementation for a strategy family
- one `UpgradeableBeacon` for that family
- one `BeaconProxy` per live lane

This reduces repeated deployment cost and keeps strategy families consistent, but it also means a beacon upgrade affects every lane attached to that beacon.

## Read Next

- [v2-accounting-walkthrough.md](v2-accounting-walkthrough.md)
- [accounting-and-tvl.md](accounting-and-tvl.md)
- [strategy-model.md](strategy-model.md)
- [../integrations/gho-sgho.md](../integrations/gho-sgho.md)
- [../design-decisions/07-v2-lane-policy.md](../design-decisions/07-v2-lane-policy.md)
- [../operations/vault-upgrades-and-v2-policy.md](../operations/vault-upgrades-and-v2-policy.md)
