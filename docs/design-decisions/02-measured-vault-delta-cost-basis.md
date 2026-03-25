---
title: "Measured Vault-Delta Cost Basis"
audience: "contributors, reviewers, auditors"
purpose: "explain how allocation cost basis is measured and why"
decision_type: "accounting"
---

# Measured Vault-Delta Cost Basis

## Context

The vault needs one cost-basis number for each `(vaultToken, strategy)` pair so it can determine how much yield is actually harvestable.

For legacy lanes, that number cannot safely come from:

- the requested allocation amount alone, or
- a strategy-reported receipt amount alone.

## Decision

This decision now splits by strategy family:

- legacy `IYieldStrategy` lanes increase cost basis by the vault's measured net token balance decrease during allocation,
- V2 `IYieldStrategyV2` lanes increase cost basis by strategy-reported `invested`, while the vault keeps measured balance-delta checks only as reconciliation guards.

This is an explicit trust tradeoff for V2. The vault no longer derives an independent lower bound on deployed principal for V2 entry accounting.

## Alternatives Considered

Using the requested amount unconditionally:

- rejected because a strategy may pull less than requested,
- rejected because it would overstate deployed capital and suppress real future yield.

Using the strategy's reported receipt amount for all lanes:

- rejected for legacy because it trusts a downstream surface the vault does not need to trust,
- rejected because deposit-time friction such as fee-on-transfer would later be misclassified as profit.

Using strategy-reported `invested` for V2 only:

- accepted because V2 lanes are governance-controlled, single-lane adapters with a narrower trust model,
- accepted because tracked entry/exit fees are reimbursed by treasury, so `costBasis = invested` keeps impairment detection cleaner for the intended V2 policy,
- accepted with the known limitation that the vault only upper-bounds `invested` with measured spend and does not independently prove a lower bound.

## Consequences

- legacy cost basis reflects what actually left the vault,
- legacy under-spend behavior is represented correctly,
- legacy deposit friction is treated as cost or loss, not future harvestable yield,
- V2 entry accounting is simpler and matches the governance-controlled reimbursement model,
- V2 harvest math depends on strategy-reported `invested` remaining honest across implementation changes.

## Worked Examples

Legacy fee-on-transfer example:

- requested allocation: `100`
- strategy receives: `99`
- stored cost basis: `100`
- later exposure: `120`
- harvestable yield: `20`, not `21`

Legacy partial-pull example:

- requested allocation: `100`
- strategy actually pulls: `90`
- stored cost basis: `90`
- later exposure: `120`
- harvestable yield: `30`

V2 trusted-entry example:

- requested allocation: `100`
- vault-side spent: `100`
- strategy-reported invested: `99`
- stored V2 cost basis: `99`
- treasury reimburses entry fee: `1`

This is the intended V2 model. It is simpler than measured-delta principal accounting, but it trusts the strategy to report `invested` honestly.

## Harvest Implications

Harvest intentionally combines separate measurements:

- strategy exposure,
- vault-side measured balance change,
- yield-recipient-side received amount.

For legacy, that separation keeps the vault from trusting strategy-reported returns and keeps deposit friction from being reclassified as profit later.

For V2, the vault still measures realized withdraw and harvest receipts, but the entry-side principal number comes from strategy-reported `invested`.

## Related Docs

- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [../operations/runbook.md](../operations/runbook.md)
- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
