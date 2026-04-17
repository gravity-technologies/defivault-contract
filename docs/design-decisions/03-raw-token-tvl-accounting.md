---
title: "Raw-Token TVL Accounting"
audience: "contributors, auditors, indexers"
purpose: "explain why TVL is reported as raw per-token amounts"
decision_type: "accounting and reporting"
---

# Raw-Token TVL Accounting

## Context

The vault reports balances for multiple token types:

- supported vault tokens such as `USDT`,
- receipt or component tokens such as `aUSDT`,
- residual token balances inside strategies.

Those tokens are not always interchangeable and should not be converted implicitly on-chain.

## Decision

The vault reports TVL as raw per-token amounts. It does not perform on-chain cross-token valuation or aggregation.

## Alternatives Considered

On-chain aggregation into one normalized value:

- rejected because it would require conversion assumptions, pricing inputs, or protocol-specific math inside the vault,
- rejected because it would make reporting more brittle and less auditable.

Treating component tokens as if they were the same as the vault token:

- rejected because exact-token accounting and economic exposure are different surfaces,
- rejected because it would make token-level totals ambiguous.

## Consequences

- `USDT` totals remain in `USDT` units,
- `aUSDT` totals remain in `aUSDT` units,
- exact-token totals stay simple and auditable,
- any USD or cross-token aggregation must happen off-chain.

## Worked Example

Example state:

- vault idle: `USDT = 200`, `aUSDT = 0`
- strategy A reports: `aUSDT = 1000`, residual `USDT = 20`
- strategy B reports: `aUSDT = 500`, residual `USDT = 10`

Results:

- `tokenTotals(USDT) = 230`
- `tokenTotals(aUSDT) = 1500`

The vault does not convert `aUSDT` into `USDT` during reporting.

## Operational Implications

- dashboards and indexers must treat each token row as a raw amount,
- component tokens should not be confused with off-chain value conversions,
- exact-token reporting and exposure math should stay separate.

## Related Docs

- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [04-cached-tracked-tvl-token-registry.md](04-cached-tracked-tvl-token-registry.md)
- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
