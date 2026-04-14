# Documentation Guide

## Metadata

- Audience: contributors, operators, integrators, reviewers
- Purpose: provide the top-level map for the repository documentation
- Canonical for: documentation navigation and reading paths

This docs tree is organized top-down: start with concepts, then architecture, then operations, reference surfaces, and design decisions.

## Start Here

- [concepts/system-overview.md](concepts/system-overview.md): stable mental model and terminology.
- [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md): cost basis, exposure, tracked TVL tokens, and indexer guidance.
- [concepts/strategy-model.md](concepts/strategy-model.md): canonical strategy adapter model, V2 trust assumptions, and reporting rules.
- [concepts/v2-strategy-brief.md](concepts/v2-strategy-brief.md): reviewer-oriented summary of the V2 lane model.
- [concepts/v2-accounting-walkthrough.md](concepts/v2-accounting-walkthrough.md): worked V2 accounting examples using the SGHO lane.
- [architecture/vault-and-gateways.md](architecture/vault-and-gateways.md): how the implemented contracts fit together.
- [operations/vault-upgrades-and-v2-policy.md](operations/vault-upgrades-and-v2-policy.md): current vault-upgrade and V2 lane activation procedure.
- [reference/roles-and-permissions.md](reference/roles-and-permissions.md): compact role and policy matrix.
- [design-decisions/README.md](design-decisions/README.md): rationale for the non-obvious design choices.

## Reading Paths

### Contributor

1. [concepts/system-overview.md](concepts/system-overview.md)
2. [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md)
3. [concepts/v2-strategy-brief.md](concepts/v2-strategy-brief.md)
4. [architecture/vault-and-gateways.md](architecture/vault-and-gateways.md)
5. [design-decisions/README.md](design-decisions/README.md)

### Operator

1. [reference/roles-and-permissions.md](reference/roles-and-permissions.md)
2. [operations/runbook.md](operations/runbook.md)
3. [operations/vault-upgrades-and-v2-policy.md](operations/vault-upgrades-and-v2-policy.md)
4. [design-decisions/05-native-boundary-and-gateway-split.md](design-decisions/05-native-boundary-and-gateway-split.md)
5. [design-decisions/06-explicit-native-bridge-methods.md](design-decisions/06-explicit-native-bridge-methods.md)
6. [design-decisions/12-remove-emergency-bridge-surface.md](design-decisions/12-remove-emergency-bridge-surface.md)

### Integrator

1. [concepts/system-overview.md](concepts/system-overview.md)
2. [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md)
3. [concepts/strategy-model.md](concepts/strategy-model.md)
4. [concepts/v2-accounting-walkthrough.md](concepts/v2-accounting-walkthrough.md)
5. [integrations/README.md](integrations/README.md)
6. [design-decisions/README.md](design-decisions/README.md)

### Auditor / Reviewer

1. [concepts/system-overview.md](concepts/system-overview.md)
2. [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md)
3. [concepts/strategy-model.md](concepts/strategy-model.md)
4. [concepts/v2-strategy-brief.md](concepts/v2-strategy-brief.md)
5. [concepts/v2-accounting-walkthrough.md](concepts/v2-accounting-walkthrough.md)
6. [reference/roles-and-permissions.md](reference/roles-and-permissions.md)
7. [architecture/vault-and-gateways.md](architecture/vault-and-gateways.md)
8. [operations/vault-upgrades-and-v2-policy.md](operations/vault-upgrades-and-v2-policy.md)
9. [design-decisions/README.md](design-decisions/README.md)

## Sections

- `concepts/`: stable mental models and terminology.
- `architecture/`: how the current implemented pieces map onto those concepts.
- `operations/`: deployment, operational procedures, and incident handling.
- `reference/`: compact factual surfaces that should stay close to the code.
- `integrations/`: protocol-specific adapter notes. Status is called out per page.
- `design-decisions/`: why specific design choices exist and what operational consequences follow from them.

## Current Implementation Status

- Implemented in this repo:
  - `GRVTL1TreasuryVault`
  - `GRVTL1TreasuryVaultViewModule`
  - `GRVTL1TreasuryVaultOpsModule`
  - `NativeVaultGateway`
  - `NativeBridgeGateway`
- `AaveV3Strategy`
- `AaveV3StrategyV2`
- `SGHOStrategy`
- `YieldRecipientTreasury`
- Not implemented in this repo:
  - Compound adapter
  - Morpho adapter
  - sUSDe adapter
