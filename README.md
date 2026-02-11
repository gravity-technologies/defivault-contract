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
                        allocate/deallocate |           | requestL2TransactionTwoBridges(...)
                                            v           v
                                   +----------------+  +---------------------------+
                                   | Yield Strategy |  | BridgeHub + SharedBridge  |
                                   | (AaveV3 first) |  | (two-bridges request)     |
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

### Token Registry and Raw TVL Accounting

The vault reports TVL in raw token units (no USD conversion inside the contract).

For each token, accounting is deterministic:

```text
totalAssets(token) = idleAssets(token) + sum(strategy.assets(token) for active strategies)
```

Where:
- `idleAssets(token)` is the vault's direct ERC20 balance.
- `strategy.assets(token)` MUST be reported in underlying token units (e.g. USDT, not aUSDT).

The vault maintains a token registry for TVL discovery:
- `getTrackedTokens()` returns the current token set that should be tracked for TVL.
- `isTrackedToken(token)` checks if a token is currently in that set.
- Tokens remain tracked while they still have exposure, even if `token.supported` is disabled.
- A token is removed from tracking only when unsupported and fully unwound.

### How 3rd-Party Trackers Should Compute TVL

For accurate on-chain TVL ingestion:

1. Read tracked token list:
   - `tokens = getTrackedTokens()`
2. Read batch totals:
   - `(totals, skipped) = totalAssetsBatch(tokens)`
3. Interpret each token row:
   - `totals[i]` is the raw token amount for `tokens[i]`.
   - `skipped[i] == 0` means no strategy read failures for that token.
   - `skipped[i] > 0` means total is a conservative lower bound (one or more strategies could not be read safely).
4. (Optional) For diagnostics, inspect:
   - `getTokenStrategies(token)`
   - `strategyAssets(token, strategy)` per strategy.

Notes:
- The contract does not provide cross-token aggregation or pricing.
- Any USD TVL metric should be computed off-chain by applying external price feeds to raw per-token totals.

### Normal Yield Flow (Allocate / Deallocate)

```text
[ALLOCATOR role]
      |
      v
GRVTDeFiVault.allocateToStrategy(token, strategy, amount)
      |
      +--> checks: token supported, strategy whitelisted, cap, pause
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
GRVTDeFiVault.rebalanceToL2(token, amount)
      |
      +--> checks: paused? no, token supported, bridge config valid
      +--> enforces: l2ExchangeRecipient fixed at initialization (no admin setter)
      +--> requires msg.value == 0
      +--> mints base token for BridgeHub mintValue
      +--> calls bridgeHub.requestL2TransactionTwoBridges(...)
      |
      v
BridgeHub dispatches shared bridge deposit and emits L2 tx hash metadata
```

### Emergency Liquidity Restoration Flow

```text
[REBALANCER or VAULT_ADMIN]
      |
      v
GRVTDeFiVault.emergencySendToL2(token, amount)
      |
      +--> allowed while paused
      +--> callable even if token support has been disabled
      +--> pulls liquidity from active strategies (including withdraw-only de-whitelisted entries)
      +--> vault uses measured balance deltas per unwind step
      +--> requires msg.value == 0
      +--> mints base token and submits TwoBridges request
```

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```
