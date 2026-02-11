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

| Function                    | Required caller                         | Blocked by pause | Requires `token.supported` |
| --------------------------- | --------------------------------------- | ---------------- | -------------------------- |
| `allocateToStrategy`        | `ALLOCATOR_ROLE`                        | Yes              | Yes                        |
| `deallocateFromStrategy`    | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No               | No                         |
| `deallocateAllFromStrategy` | `ALLOCATOR_ROLE` or `VAULT_ADMIN_ROLE`  | No               | No                         |
| `rebalanceToL2`             | `REBALANCER_ROLE`                       | Yes              | Yes                        |
| `emergencySendToL2`         | `REBALANCER_ROLE` or `VAULT_ADMIN_ROLE` | No               | No                         |

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

Note:

- Deposits/top-ups are ETH-free at protocol level (`msg.value` must be `0`).
- Bridge execution cost is funded via minted BaseToken (`mintValue`), not ETH value transfer.
- Standard L1 transaction gas still applies for the caller submitting the transaction.

### Why BaseToken Minting Exists (Private Chain Deposit Control)

GRVT intentionally uses a controlled base-token model for L1 -> L2 bridging.

- Goal: enforce private-chain deposit policy (including AML controls).
- Practical rule: only flows backed by GRVT-controlled BaseToken can be bridged into the private L2 environment.
- In this vault, every L1 -> L2 rebalance computes the bridge `mintValue`, mints BaseToken, then submits a two-bridges request through BridgeHub.

Operational implication:

- The contract/address that performs this bridge flow must have minter permission in GRVT bridge infrastructure.
- In GRVT's proxy-bridging stack, this permission is managed on `GRVTBridgeProxy`:
  https://github.com/gravity-technologies/proxy-bridging-contracts/blob/f79d8f9beca5712c658ea9d6074f2f75ea2e70ea/contracts/proxy-bridging/GRVTBridgeProxy.sol

If minter permission is missing, bridge top-ups fail because required BaseToken cannot be minted.

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

## Risk Controls Semantics

- `rebalanceToL2` is the normal risk-on path and is blocked by pause and token-support checks.
- `emergencySendToL2` intentionally bypasses pause and token-support checks to prioritize incident-time liquidity restoration.
- Emergency actions remain role-gated and should be used under incident procedures defined in `docs/operations-runbook.md`.

## Usage

### Running Tests

Run all tests:

```shell
npm run test
```

Run only fork integration tests (requires mainnet RPC):

```shell
MAINNET_RPC_URL=<rpc-url> npx hardhat test test/fork/*.ts
```

Optional fork block pin:

```shell
MAINNET_RPC_URL=<rpc-url> MAINNET_FORK_BLOCK=22000000 npx hardhat test test/fork/*.ts
```

### Ignition Deployments

Use `.env` for network credentials (`SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY`),
and keep deployment inputs in Ignition parameter files under `ignition/parameters/`.

Deploy vault core:

```shell
npm run deploy:vault -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/vault-core.json5
```

Deploy token + Aave strategy for an existing vault:

```shell
npm run deploy:token-strategy -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/token-strategy.json5
```

Bootstrap vault roles:

```shell
npm run roles:bootstrap -- \
  --network sepolia \
  --parameters ignition/parameters/sepolia/roles-bootstrap.json5
```

Inspect deployment state:

```shell
npx hardhat ignition deployments --network sepolia
npx hardhat ignition status <deployment-id> --network sepolia
```

Ignition deployment state is the source of truth and is stored under
`ignition/deployments/`.

### Ops Docs

- Incident/deployment runbook: `docs/operations-runbook.md`
