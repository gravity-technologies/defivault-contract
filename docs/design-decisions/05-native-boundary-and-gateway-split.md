---
title: "Native Boundary and Gateway Split"
audience: "contributors, reviewers, operators"
purpose: "explain why native ETH boundaries are split across dedicated contracts"
decision_type: "architecture and operational boundary"
---

# Native Boundary and Gateway Split

## Context

The vault keeps its internal accounting in ERC20 token space, but the system still needs to handle native ETH at specific boundaries:

- external ETH ingress,
- native L1 -> L2 bridge execution,
- failed native deposit recovery,
- wrapped-native harvest payout.

If the vault itself were the general-purpose ETH boundary, accounting and recovery behavior would become harder to reason about and easier to misuse operationally.

## Decision

The implemented design uses:

- `NativeVaultGateway` for planned external ETH ingress,
- `NativeBridgeGateway` for native bridge execution and failed native deposit recovery,
- wrapped-native as the vault's internal representation of native exposure.

## Alternatives Considered

Direct ETH ingress to the vault:

- rejected because it would make the vault a general ETH custody point and blur accounting boundaries.

Making the vault the native bridge deposit sender:

- rejected because failed native deposits would then try to return ETH directly to the vault instead of to a dedicated recovery boundary.

## Consequences

- deployment has one more moving part because `NativeBridgeGateway` is separately deployed and configured,
- operators must understand that native ingress and native bridge execution use different contracts,
- the accounting model stays simpler because normal vault and strategy logic remain ERC20-based,
- failed native deposit recovery can normalize ETH back into wrapped-native before funds re-enter vault accounting.

## Operational Implications

- planned external ETH should enter through `NativeVaultGateway`, not directly to the vault,
- native bridge sends should end at `NativeBridgeGateway`,
- failed native deposit recovery should terminate at `NativeBridgeGateway`, not at the vault,
- wrapped-native harvest is an intentional payout boundary where the yield recipient receives ETH.

## Common Failure Cases

- direct ETH sent to the vault is not a normal ingress path,
- native bridge intent routed through the ERC20 bridge path is incorrect,
- unexpected ETH sitting in the vault usually indicates forced ETH or a misrouted flow,
- failed native recovery ending anywhere except `NativeBridgeGateway` breaks the intended boundary model.

## Related Docs

- [../concepts/system-overview.md](../concepts/system-overview.md)
- [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)
- [06-explicit-native-bridge-methods.md](06-explicit-native-bridge-methods.md)
