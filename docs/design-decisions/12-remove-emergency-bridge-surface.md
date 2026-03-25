---
title: "Remove Emergency Bridge Surface"
added: "2026-04-02"
audience: "contributors, reviewers, auditors, operators"
purpose: "record why the dedicated emergency bridge and auto-unwind entrypoints were removed from the vault and why no separate emergency-exit mode remains"
decision_type: "api design, incident operations, simplification"
---

# 12 Remove Emergency Bridge Surface

## Context

The vault originally had dedicated incident-time bridge entrypoints:

- `emergencyNativeToL2(uint256 amount)`
- `emergencyErc20ToL2(address erc20Token, uint256 amount)`

Those methods did more than bridge idle balances.

They also:

- bypassed the normal pause gate,
- auto-unwound strategy positions before bridging,
- chose unwind order from the vault registry rather than operator intent.

That model stopped making sense once the team aligned on the newer policy:

- incident exits should follow the same fee-cap checks as normal exits,
- reimbursing lanes should use the same reimbursement rules as normal exits,
- violating a cap should fail closed rather than silently continue.

At that point the emergency surface no longer provided a distinct safety model.

The remaining "emergency exit" idea was also not compelling operationally:

- once cap checks and reimbursement semantics match normal deallocation, the extra surface does not change outcome,
- strategy unwind order should be operator-chosen rather than registry-order first-come-first-serve,
- large exits may be venue-liquidity-sensitive, so batching should stay explicit and controllable,
- convenience alone was not enough reason to keep another privileged surface.

It was just a less controllable batcher:

- it unwound in fixed registry order,
- it had no venue-priority or liquidity-aware sequencing,
- it increased bytecode and audit surface,
- it encoded incident behavior on-chain that operators could choose better off-chain.

## Decision

The dedicated emergency bridge surface is removed.

That means:

- `emergencyNativeToL2` is removed,
- `emergencyErc20ToL2` is removed,
- the vault no longer auto-iterates strategies for incident bridge requests,
- incident-time exits use the same deallocation and reimbursement semantics as normal exits,
- L1 -> L2 movement always goes through `rebalanceNativeToL2` or `rebalanceErc20ToL2`.

Incident response is now an explicit operator workflow:

1. pause if risk-on actions must stop,
2. deallocate the chosen lanes in the chosen order,
3. restore token support if the normal bridge path needs it,
4. unpause,
5. bridge idle funds through the normal path.

## Why Remove It Instead Of Keeping It As A Convenience Wrapper

Keeping the emergency methods as thin wrappers was rejected because the wrappers still carried the wrong abstraction.

The question in an incident is not "bridge now using a special entrypoint."

It is:

- which positions should be unwound first,
- which venues still have usable liquidity,
- whether one lane should be skipped because cap checks or venue liquidity make it a bad candidate,
- whether the token should remain supported,
- whether the system should stay paused until the final bridge step.

Those are operator decisions, not good defaults for an on-chain first-come-first-serve loop.

Once emergency and normal exits share the same fee policy, the dedicated surface is mostly duplicate code with worse control.

## Alternatives Considered

Keep the emergency selectors but make them idle-only bridge wrappers:

- rejected because the extra API surface still adds documentation, review, and operator ambiguity,
- rejected because unpausing before the final bridge step was acceptable to the team.

Keep the old emergency auto-unwind but enforce the same caps and reimbursement rules:

- rejected because it keeps the least flexible part of the original design,
- rejected because it gives the appearance of an "emergency mode" without any real semantic difference from explicit deallocate plus rebalance.

## Consequences

- the vault API is smaller and easier to reason about,
- bytecode and test surface are reduced,
- incident handling is more explicit and more operator-controlled,
- there is no on-chain best-effort strategy iteration for bridge restoration,
- a paused vault must be unpaused before the final L1 -> L2 rebalance step,
- the bridge event no longer carries an `emergency` compatibility flag because there is no separate emergency bridge mode.

## Related Docs

- [06-explicit-native-bridge-methods.md](06-explicit-native-bridge-methods.md)
- [07-v2-lane-policy.md](07-v2-lane-policy.md)
- [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)
- [../operations/runbook.md](../operations/runbook.md)
- [../operations/vault-upgrades-and-v2-policy.md](../operations/vault-upgrades-and-v2-policy.md)
