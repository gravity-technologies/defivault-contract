---
title: "Legacy Vault Upgrade Path"
added: "2026-04-02"
audience: "contributors, reviewers, auditors, operators"
purpose: "document how the deployed legacy vault lineage moves to the current vault while keeping legacy strategy support"
decision_type: "upgrade safety, compatibility, rollout"
---

# 09 Legacy Vault Upgrade Path

## Context

The vault proxy lineage already exists.

At the same time:

- the legacy `IYieldStrategy` surface must remain usable for deployed lanes such as `AaveV3Strategy`,
- no V2 strategy had been deployed yet,
- the vault needed major internal changes for V2 policy, treasury reimbursement, and bytecode size.

So the upgrade problem was asymmetric:

- preserve storage and legacy behavior where it is already live,
- redesign V2 cleanly where nothing is deployed yet.

## Decision

The vault upgrade path is:

1. keep proxy and storage compatibility for the vault itself,
2. keep legacy `IYieldStrategy` support in the upgraded vault,
3. break V2 interfaces where needed,
4. migrate to V2 by deploying new lanes, not by in-place strategy upgrades,
5. prove the path with a real proxy-upgrade test from a legacy-compatible implementation to the current implementation.

This means:

- `AaveV3Strategy` remains backward-compatible,
- `AaveV3StrategyV2` and `GsmStkGhoStrategy` are new lanes added after the vault upgrade,
- the vault can service both legacy and V2 strategy surfaces at runtime,
- operators can stop new allocations to legacy lanes, drain them, and move capital to V2 lanes over time.

## Why Not Upgrade Legacy Strategies In Place

In-place strategy upgrades were rejected for this migration because they mix two risks:

- strategy logic change,
- vault interface and policy change.

Deploying fresh V2 lanes is cleaner:

- legacy funds can be drained on the old lane semantics,
- V2 lanes start with the new immutable lane metadata,
- operators can review policy activation lane by lane,
- rollback is simpler because legacy lanes still exist until capital is moved.

## Evidence In This Repo

The repository now carries a real upgrade proof:

- a legacy-compatible vault implementation is deployed behind a proxy,
- state and roles are populated on that legacy implementation,
- the proxy is upgraded to the current `GRVTL1TreasuryVault`,
- legacy strategy deallocation still works after the upgrade,
- a fresh V2 lane can be added and used after the upgrade.

That proof lives in `test/unit/VaultUpgrade.test.ts`.

## Consequences

- Vault upgrades must be evaluated as storage-compatible changes even when V2 ABI changes.
- Strategy migration is operational, not automatic.
- Legacy lanes and V2 lanes can coexist during migration.
- Deployment records now need to capture the helper modules deployed with the current vault implementation.

## Related Docs

- [07-v2-lane-policy.md](07-v2-lane-policy.md)
- [10-static-vault-modules-for-bytecode-limit.md](10-static-vault-modules-for-bytecode-limit.md)
- [../operations/vault-upgrades-and-v2-policy.md](../operations/vault-upgrades-and-v2-policy.md)
