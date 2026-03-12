# Documentation Guide

## Metadata

- Audience: contributors, operators, integrators, reviewers
- Purpose: provide the top-level map for the repository documentation
- Canonical for: documentation navigation and reading paths

This docs tree is organized top-down: start with concepts, then architecture, then operations, reference surfaces, and design decisions.

## Start Here

- [concepts/system-overview.md](concepts/system-overview.md): stable mental model and terminology.
- [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md): cost basis, exposure, tracked TVL tokens, and indexer guidance.
- [concepts/strategy-model.md](concepts/strategy-model.md): canonical strategy adapter model and reporting rules.
- [architecture/vault-and-gateways.md](architecture/vault-and-gateways.md): how the implemented contracts fit together.
- [reference/roles-and-permissions.md](reference/roles-and-permissions.md): compact role and policy matrix.
- [design-decisions/README.md](design-decisions/README.md): rationale for the non-obvious design choices.

## Reading Paths

### Contributor

1. [concepts/system-overview.md](concepts/system-overview.md)
2. [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md)
3. [architecture/vault-and-gateways.md](architecture/vault-and-gateways.md)
4. [design-decisions/README.md](design-decisions/README.md)

### Operator

1. [reference/roles-and-permissions.md](reference/roles-and-permissions.md)
2. [operations/runbook.md](operations/runbook.md)
3. [design-decisions/native-boundary-and-gateway-split.md](design-decisions/native-boundary-and-gateway-split.md)
4. [design-decisions/explicit-native-bridge-methods.md](design-decisions/explicit-native-bridge-methods.md)

### Integrator

1. [concepts/system-overview.md](concepts/system-overview.md)
2. [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md)
3. [concepts/strategy-model.md](concepts/strategy-model.md)
4. [integrations/README.md](integrations/README.md)
5. [design-decisions/README.md](design-decisions/README.md)

### Auditor / Reviewer

1. [concepts/system-overview.md](concepts/system-overview.md)
2. [concepts/accounting-and-tvl.md](concepts/accounting-and-tvl.md)
3. [concepts/strategy-model.md](concepts/strategy-model.md)
4. [reference/roles-and-permissions.md](reference/roles-and-permissions.md)
5. [architecture/vault-and-gateways.md](architecture/vault-and-gateways.md)
6. [design-decisions/README.md](design-decisions/README.md)

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
  - `NativeVaultGateway`
  - `NativeBridgeGateway`
  - `AaveV3Strategy`
- Not implemented in this repo:
  - Compound adapter
  - Morpho adapter
  - sUSDe adapter
