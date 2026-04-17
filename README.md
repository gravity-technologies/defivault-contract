# GRVT L1 Treasury Vault

This repository contains the GRVT L1 treasury vault, its native-asset gateways, and the current Aave and GHO V2 strategy integrations. The contracts are built with Hardhat, use `viem` for interactions, and are designed around explicit RBAC, conservative accounting, and controlled L1 -> L2 rebalancing.

Aave, Aave V2, and GHO V2 are implemented strategy integrations in this repo today. Compound, Morpho, and sUSDe docs are design guidance for future adapters, not deployed code in this repository.

## What Is In This Repo

- `GRVTL1TreasuryVault`: upgradeable L1 vault for custody, strategy allocation, harvest, and L1 -> L2 bridge flows.
- `NativeVaultGateway`: wraps inbound ETH into the configured wrapped-native token before funds enter vault accounting.
- `NativeBridgeGateway`: handles native bridge execution and failed native deposit recovery.
- `AaveV3Strategy`: current implemented strategy adapter for one `(underlying, aToken, pool)` tuple.

## Five-Minute Architecture

```text
                         +----------------------------------+
                         |          Governance/Admin        |
                         |   (DEFAULT_ADMIN, VAULT_ADMIN)   |
                         +-----------------+----------------+
                                           |
                                           v
                         +---------------------------+
                         |    GRVTL1TreasuryVault    |
                         |     (upgradeable core)    |
                         +----+-----------------+----+
                              |                 |
         allocate/deallocate  |                 | requestL2TransactionTwoBridges(...)
                              v                 v
                     +----------------+   +---------------------------+
                     | Yield Strategy |   | BridgeHub + SharedBridge  |
                     | (AaveV3 first) |   | (two-bridges request)     |
                     +--------+-------+   +-------------+-------------+
                              |                           |
                              v                           v
                      External DeFi venue         L1 custody + L2 routing
```

The stable mental model is:

- the vault keeps internal accounting in ERC20 token space,
- V2 strategies are trusted implementations with local execution bookkeeping,
- the vault owns the authoritative principal ledger for V2 lanes,
- strategies expose the reporting surfaces the vault needs for cap and harvest logic,
- V2 impairment is a one-way governance write-down action, not an automatic recovery mechanism,
- raw ETH appears only at explicit boundaries,
- incident-time restoration uses the same explicit deallocate-then-rebalance flow as normal operations.

## Local Development

```bash
npm install
npm run compile
npm run test
npm run test:fork
```

Full local validation:

```bash
npm run check:all
npm run slither
```

Interactive initial stack deployment:

```bash
npm run deploy:initial-stack
```

The interactive initial-stack deploy is environment-aware:

- `staging` and `testnet` deploy mock Aave contracts because GRVT supplies its own underlying test token
- `production` validates the configured live Aave pool and aToken instead of deploying mocks

See [docs/operations/runbook.md](docs/operations/runbook.md).

## Read Next

- Start with [docs/README.md](docs/README.md)
- Mental model: [docs/concepts/system-overview.md](docs/concepts/system-overview.md)
- Accounting and TVL: [docs/concepts/accounting-and-tvl.md](docs/concepts/accounting-and-tvl.md)
- V2 strategy brief: [docs/concepts/v2-strategy-brief.md](docs/concepts/v2-strategy-brief.md)
- V2 accounting walkthrough: [docs/concepts/v2-accounting-walkthrough.md](docs/concepts/v2-accounting-walkthrough.md)
- Implemented architecture: [docs/architecture/vault-and-gateways.md](docs/architecture/vault-and-gateways.md)
- Operational procedures: [docs/operations/runbook.md](docs/operations/runbook.md)
- Design decisions: [docs/design-decisions/README.md](docs/design-decisions/README.md)

## Code Surfaces

- Vault interface: [contracts/interfaces/IL1TreasuryVault.sol](contracts/interfaces/IL1TreasuryVault.sol)
- Vault implementation: [contracts/vault/GRVTL1TreasuryVault.sol](contracts/vault/GRVTL1TreasuryVault.sol)
- Strategy interface: [contracts/interfaces/IYieldStrategy.sol](contracts/interfaces/IYieldStrategy.sol)
- Current strategy: [contracts/strategies/AaveV3Strategy.sol](contracts/strategies/AaveV3Strategy.sol)
