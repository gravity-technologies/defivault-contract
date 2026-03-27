---
title: "Explicit Native Bridge Methods"
audience: "contributors, reviewers, operators, integrators"
purpose: "explain why native bridge intent uses explicit methods instead of a sentinel token"
decision_type: "API design"
---

# Explicit Native Bridge Methods

## Context

The system needs to support both ERC20 bridge intent and native bridge intent. A common alternative is to overload one ERC20-style function and use `address(0)` as a native sentinel.

That looks compact, but it blurs bridge intent in both code and docs and makes drift more likely.

## Decision

The vault uses explicit native bridge methods:

- `rebalanceNativeToL2(uint256 amount)`
- `emergencyNativeToL2(uint256 amount)`

ERC20 bridge intent remains separate:

- `rebalanceErc20ToL2(address erc20Token, uint256 amount)`
- `emergencyErc20ToL2(address erc20Token, uint256 amount)`

## Alternatives Considered

Using `rebalanceErc20ToL2(address(0), amount)` as a native sentinel:

- rejected because the call shape hides intent,
- rejected because it is easier to document incorrectly and easier for integrators to misuse,
- rejected because native and ERC20 branches have materially different runtime behavior.

## Consequences

- native bridge intent is obvious from the function name,
- ERC20 and native paths can enforce different invariants more clearly,
- docs and operator procedures can point to explicit methods instead of relying on sentinel conventions,
- wrapped-native can be rejected from the ERC20 bridge path without ambiguity.

## Operational Implications

- operators should always choose between the native and ERC20 methods explicitly,
- indexers and reviewers can distinguish native-intent bridge sends from ERC20-intent sends directly from the called function,
- any old documentation that mentions `address(0)` as native bridge intent should be treated as stale.

## Related Docs

- [05-native-boundary-and-gateway-split.md](05-native-boundary-and-gateway-split.md)
- [../reference/roles-and-permissions.md](../reference/roles-and-permissions.md)
- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
