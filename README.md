# GRVT L1 DefiVault Contract

This repository contains the **GRVT L1 DefiVault contract** and its Hardhat-based development environment, using the native Node.js test runner (`node:test`) and `viem` for Ethereum interactions.

In simple terms, this contract helps put GRVT TVL to work by allocating funds into established DeFi venues such as Aave, so the vault can generate on-chain yield in a structured way.

## Project Overview

This repository contains:

- `GRVTDeFiVault`: L1 vault with RBAC, pause semantics, strategy routing, and L1->L2 rebalance/emergency flows.
- `AaveV3Strategy`: vault-only strategy integration for Aave v3 (USDT-first).
- `ZkSyncNativeBridgeAdapter`: vault-only adapter abstraction for L1 custody/bridge sends.

The design enforces strict asset-flow restrictions, strategy whitelisting, and emergency controls.

## Architecture and Major Flows

### High-Level Structure

```text
                         +----------------------------------+
                         |          Governance/Admin        |
                         |   (DEFAULT_ADMIN, VAULT_ADMIN)   |
                         +-----------------+----------------+
                                           |
                                           v
+---------------------+      calls     +---------------------+
|  Rebalancer/Ops     +--------------->+    GRVTDeFiVault    |
| (REBALANCER/PAUSER) |                | (upgradeable core)  |
+---------------------+                +----+-----------+----+
                                            |           |
                        allocate/deallocate |           | sendToL2(token,amount,recipient)
                                            v           v
                                   +----------------+  +---------------------------+
                                   | Yield Strategy |  | ExchangeBridgeAdapter     |
                                   | (AaveV3 first) |  | (zkSync native adapter)   |
                                   +--------+-------+  +-------------+-------------+
                                            |                        |
                                            v                        v
                                    External DeFi venue        L1 custody + L2 routing
```

### Fund-Moving Policy Matrix

| Function | Required caller | Blocked by pause | Requires `token.supported` |
|---|---|---|---|
| `allocateToStrategy` | `ALLOCATOR_ROLE` | Yes | Yes |
| `deallocateFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE` | No | No |
| `deallocateAllFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE` | No | No |
| `rebalanceToL2` | `REBALANCER_ROLE` | Yes | Yes |
| `emergencySendToL2` | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No | No |

### Normal Yield Flow (Allocate / Deallocate)

```text
[ALLOCATOR role]
      |
      v
GRVTDeFiVault.allocateToStrategy(token, strategy, amount)
      |
      +--> checks: token supported, strategy whitelisted, reserve/cap, pause
      +--> token approve(strategy)
      +--> strategy.allocate(...)

[ALLOCATOR or VAULT_ADMIN]
      |
      v
GRVTDeFiVault.deallocateFromStrategy(...)
      |
      +--> checks: strategy is withdrawable (whitelisted or still active in strategy set)
      +--> strategy.deallocate(...)
      +--> vault measures actual received via balance delta (does not trust strategy return value)
      +--> funds return to vault idle balance
```

### Normal Rebalance Flow (L1 -> L2 Top-Up)

```text
[REBALANCER role]
      |
      v
GRVTDeFiVault.rebalanceToL2(token, amount, bridgeData)
      |
      +--> checks: paused? no, token supported, bridge config valid
      +--> enforces: rebalanceMaxPerTx + rebalanceMinDelay + idle reserve
      +--> updates per-token rebalance timestamp (with explicit event)
      +--> bridgeAdapter.sendToL2(token, amount, l2ExchangeRecipient, bridgeData)
      |
      v
Bridge adapter transfers token to custody and emits L2 recipient metadata
```

### Emergency Liquidity Restoration Flow

```text
[REBALANCER or VAULT_ADMIN]
      |
      v
GRVTDeFiVault.emergencySendToL2(token, amount, bridgeData)
      |
      +--> allowed while paused
      +--> callable even if token support has been disabled
      +--> bypasses rebalanceMaxPerTx and rebalanceMinDelay
      +--> pulls liquidity from active strategies (including withdraw-only de-whitelisted entries)
      +--> vault uses measured balance deltas per unwind step
      +--> bridgeAdapter.sendToL2(...)
```

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
- Incident/deployment runbook: `docs/operations-runbook.md`
