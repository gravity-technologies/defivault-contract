# GRVT L1 DefiVault Contract

This repository contains the **GRVT L1 DefiVault contract** and its Hardhat-based development environment, using the native Node.js test runner (`node:test`) and `viem` for Ethereum interactions.

In simple terms, this contract helps put GRVT TVL to work by allocating funds into established DeFi venues such as Aave, so the vault can generate on-chain yield in a structured way.

## Project Overview

This repository contains:

- `GRVTDeFiVault`: L1 vault with RBAC, pause semantics, strategy routing, and L1->L2 rebalance/emergency flows.
- `AaveV3Strategy`: vault-only strategy integration for Aave v3 (USDT-first).
- `ZkSyncNativeBridgeAdapter`: vault-only adapter abstraction for L1 custody/bridge sends.

The design enforces strict asset-flow restrictions, strategy whitelisting, and emergency controls.

## Usage

### Running Tests

Run all tests:

```shell
npx hardhat test
```

Run only fork integration tests (requires mainnet RPC):

```shell
MAINNET_RPC_URL=<rpc-url> npx hardhat test test/fork/*.ts
```

Optional fork block pin:

```shell
MAINNET_RPC_URL=<rpc-url> MAINNET_FORK_BLOCK=22000000 npx hardhat test test/fork/*.ts
```

### Scripts

Deploy vault + strategy + adapter proxy stack:

```shell
DEPLOY_ADMIN=<addr> \
L2_EXCHANGE_RECIPIENT=<addr> \
CUSTODY_ADDRESS=<addr> \
AAVE_POOL=<addr> \
UNDERLYING_TOKEN=<addr> \
A_TOKEN=<addr> \
npx hardhat run scripts/deploy/deploy-vault-stack.ts --network <network>
```

Bootstrap vault roles and optional config updates:

```shell
VAULT_PROXY=<addr> \
ALLOCATOR_ADDRESSES=<addr1,addr2> \
REBALANCER_ADDRESSES=<addr1,addr2> \
PAUSER_ADDRESSES=<addr1,addr2> \
npx hardhat run scripts/roles/bootstrap-vault-roles.ts --network <network>
```

### Ops Docs

- Threat model: `docs/threat-model.md`
- Incident/deployment runbook: `docs/operations-runbook.md`
