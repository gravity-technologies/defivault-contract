---
title: "Measured Vault-Delta Cost Basis"
audience: "contributors, reviewers, auditors"
purpose: "explain how allocation cost basis is measured and why"
decision_type: "accounting"
---

# Measured Vault-Delta Cost Basis

## Context

The vault needs one cost-basis number for each `(vaultToken, strategy)` pair so it can determine how much yield is actually harvestable.

That number cannot safely come from:

- the requested allocation amount alone, or
- a strategy-reported receipt amount alone.

## Decision

`allocateVaultTokenToStrategy(vaultToken, strategy, amount)` increases cost basis by the vault's measured net token balance decrease during allocation.

## Alternatives Considered

Using the requested amount unconditionally:

- rejected because a strategy may pull less than requested,
- rejected because it would overstate deployed capital and suppress real future yield.

Using the strategy's reported receipt amount:

- rejected because it trusts a downstream surface the vault does not need to trust,
- rejected because deposit-time friction such as fee-on-transfer would later be misclassified as profit.

## Consequences

- cost basis reflects what actually left the vault,
- under-spend behavior is represented correctly,
- deposit friction is treated as cost or loss, not future harvestable yield,
- the vault can keep harvest math independent from strategy return values.

## Worked Examples

Fee-on-transfer example:

- requested allocation: `100`
- strategy receives: `99`
- stored cost basis: `100`
- later exposure: `120`
- harvestable yield: `20`, not `21`

Partial-pull example:

- requested allocation: `100`
- strategy actually pulls: `90`
- stored cost basis: `90`
- later exposure: `120`
- harvestable yield: `30`

## Harvest Implications

Harvest intentionally combines separate measurements:

- strategy exposure,
- vault-side measured balance change,
- yield-recipient-side received amount.

That separation keeps the vault from trusting strategy-reported returns and keeps deposit friction from being reclassified as profit later.

## Related Docs

- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [../operations/runbook.md](../operations/runbook.md)
- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
