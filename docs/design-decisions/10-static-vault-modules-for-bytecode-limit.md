---
title: "Static Vault Modules For Bytecode Limit"
added: "2026-04-02"
audience: "contributors, reviewers, auditors, operators"
purpose: "explain why the vault moved heavy logic into fixed helper modules instead of adopting diamond"
decision_type: "contract size, architecture, maintainability"
---

# 10 Static Vault Modules For Bytecode Limit

## Context

The policy-native V2 work pushed `GRVTL1TreasuryVault` over the EVM deployed bytecode limit.

The size problem was real:

- the vault implementation must fit under the deploy limit even though it sits behind a proxy,
- inheritance and internal helpers do not reduce runtime size enough,
- the repo already uses OpenZeppelin transparent proxies and a simple upgrade flow.

## Decision

The vault keeps the existing transparent-proxy model and moves heavy logic into fixed helper modules:

- `GRVTL1TreasuryVaultViewModule`
- `GRVTL1TreasuryVaultOpsModule`

The main vault implementation stores those module addresses as immutable constructor arguments and calls them through fixed dispatch:

- view-heavy paths go through the view module,
- mutation-heavy V2 paths go through the ops module with `delegatecall`.

This is a static module split, not a runtime-swappable facet system.

## Why Not Diamond

Diamond was rejected because it would solve more problems than this repo actually has, while creating a larger review and operations surface:

- selector routing complexity,
- facet cut governance,
- selector collision risk,
- more complicated tooling and deployment,
- a different upgrade model from the rest of the stack.

The repo already has working transparent-proxy deployment and upgrade tooling. The size problem did not justify replacing that model.

## Consequences

- the vault implementation is back under the deployable size limit,
- some paths now pay an extra module hop,
- storage discipline matters more because the ops module executes in vault storage context,
- deployment and upgrade records must include module addresses as first-class artifacts,
- the helper modules are fixed per implementation deployment, so governance cannot hot-swap them independently.

## Related Docs

- [09-legacy-vault-upgrade-path.md](09-legacy-vault-upgrade-path.md)
- [../architecture/vault-and-gateways.md](../architecture/vault-and-gateways.md)
- [../operations/vault-upgrades-and-v2-policy.md](../operations/vault-upgrades-and-v2-policy.md)
