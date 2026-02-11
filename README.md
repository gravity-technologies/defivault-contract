# GRVT L1 DefiVault Contract

This repository contains the **GRVT L1 DefiVault contract** and its Hardhat-based development environment, using the native Node.js test runner (`node:test`) and `viem` for Ethereum interactions.

In simple terms, this contract helps put GRVT TVL to work by allocating funds into established DeFi venues such as Aave, so the vault can generate on-chain yield in a structured way.

## Project Overview

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

GRVTDeFiVault.deallocateFromStrategy(...)
      |
      +--> checks: roles + whitelist + token support
      +--> strategy.deallocate(...)
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
      +--> bypasses rebalanceMaxPerTx and rebalanceMinDelay
      +--> pulls liquidity from whitelisted strategies until target reached
      +--> bridgeAdapter.sendToL2(...)
```

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```
