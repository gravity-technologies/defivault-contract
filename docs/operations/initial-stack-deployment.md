# Initial Stack Deployment

## Metadata

- Audience: operators and contributors deploying a brand-new DefiVault stack
- Purpose: explain the interactive initial-stack deployment flow and how it selects mock Aave versus live Aave
- Canonical for: `scripts/deploy/deploy-initial-stack.ts`, environment selection, and operator expectations

## Environment Policy

This repository uses two Aave modes for the interactive initial-stack deployment:

- `staging` and `testnet`: deploy `MockAaveV3Pool` and `MockAaveV3AToken`
- `production`: use the configured live Aave pool and aToken from `ignition/parameters/production/strategy-core.json5`

The non-production environments use mock Aave because GRVT supplies its own underlying token in those flows. In practice that means the vault and strategy are often wired against a GRVT-controlled USDT or other test asset address, not a public Aave reserve address. The mock contracts provide the Aave-shaped surface needed by `AaveV3Strategy` without requiring public Aave support for that token.

Current canonical USDT addresses:

- `staging` on Sepolia: `0xd92074957c5bab4d3d065f521ede914dc660bfb5`
- `production` on Ethereum mainnet: `0xdAC17F958D2ee523a2206206994597C13D831ec7`

When those addresses change, update the matching parameter files together:

- `strategy-core.json5`
- `vault-token-config.json5`
- `vault-token-strategy.json5`
- any operation params that pin the vault token directly, such as `tasks/parameters/<env>/harvest-yield.json5`

Production is different:

- the underlying token, `aavePool`, and `aToken` must be live addresses
- Step 1 validates those live Aave addresses instead of deploying mocks
- production should be run against Ethereum mainnet, not Sepolia

Verified production initial-stack addresses:

- `deployAdmin`: `0x340d75F15bF97aF6AE518d746063c591bB5368f0`
- `finalVaultAdmin`: `0x3a23919d4aA39e096E9d6420fd6a2861A20B19e5`
- `bridgeHub`: `0x303a465B659cBB0ab36eE643eA362c509EEb5213`
- `grvtBridgeProxyFeeToken`: `0xAB3B124052F0389D1cbED221d912026Ac995bb95`
- `wrappedNativeToken`: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- `zkSync native ETH sentinel`: `0x0000000000000000000000000000000000000001`
- `aavePool`: `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`
- `underlyingToken`: `0xdAC17F958D2ee523a2206206994597C13D831ec7`
- `aToken`: `0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a`
- `yieldRecipient`: `0x6e1B2a22f8f3768040CFb0b0997851ffB5971439`

Note:

- `aavePool` is the shared Aave V3 Ethereum Pool contract. USDT is one reserve inside that pool, not a separate pool contract.
- `wrappedNativeToken` is the ERC20 wrapper used by vault accounting. Native ETH bridge payloads use the separate zkSync sentinel `0x0000000000000000000000000000000000000001`.
- The initial bootstrap admin is the throwaway deployer. Yield-recipient timelock control ends with `finalVaultAdmin`.

## Script

Use:

```bash
npm run deploy:initial-stack -- --network sepolia
```

For localhost:

```bash
npm run deploy:initial-stack:local
```

## Choosing The GRVT Environment

Remote runs prompt for the GRVT environment unless `GRVT_ENV` is already set:

```bash
GRVT_ENV=staging npm run deploy:initial-stack -- --network sepolia
GRVT_ENV=testnet npm run deploy:initial-stack -- --network sepolia
GRVT_ENV=production npm run deploy:initial-stack -- --network mainnet
```

`GRVT_ENV` selects the parameter environment. `--network` selects the actual
Hardhat target network. Keep them aligned explicitly.

Local mode defaults to `staging` and reuses `smoke-artifacts/outputs/prerequisites.json`. Local mode is only intended for the mock-Aave environments.

## What The Script Does

The script:

1. resolves the GRVT environment and Aave mode
2. runs a preflight check for chain id, deployer, balance, parameter directory, and local smoke prerequisites
3. collects or reuses parameter values, with grouped prompts for common defaults
4. stages temporary per-step parameter files outside `deployment-records/`
5. executes the initial stack deployment step-by-step with Ignition
6. optionally runs post-deploy explorer verification for remote networks
7. writes the final `record.json` and only saves raw stdout/stderr logs when a step fails

## Artifacts

Each run is stored under:

```text
deployment-records/<grvt-env>/<runId>/
```

Important files:

- `record.json`: canonical machine-readable final run state, resolved parameters, and discovered addresses
- `logs/*.stdout.log` and `logs/*.stderr.log`: saved only for failed deployment or verification steps

## Deployment Checklist

After an initial-stack deployment completes:

1. Run the interactive initial-stack deployment and confirm the run finished cleanly.
2. Record the deployed treasury vault proxy address from `record.json`.
3. Find the `GRVTBaseToken` address.
4. Using the admin key for `GRVTBaseToken`, grant `MINTER_ROLE` to the treasury vault proxy so the vault can mint bridge fee token for L1 -> L2 sends.
5. Verify the grant onchain before handing the stack to operators.

Why this matters:

- The vault mints the fee token during L1 -> L2 bridge sends to fund BridgeHub `mintValue`.
- Without minter permission on `grvtBridgeProxyFeeToken`, L1 -> L2 top-ups fail even when the vault has enough asset balance.

Example `cast` commands:

```bash
cast send <grvt-base-token> \
  "grantRole(bytes32,address)" \
  $(cast keccak "MINTER_ROLE") \
  <treasury-vault-proxy> \
  --rpc-url $L1_RPC \
  --private-key $ADMIN_PRIVATE_KEY
```

```bash
cast call <grvt-base-token> \
  "hasRole(bytes32,address)(bool)" \
  $(cast keccak "MINTER_ROLE") \
  <treasury-vault-proxy> \
  --rpc-url $L1_RPC
```

In this example:

- `<grvt-base-token>` is the `GRVTBaseToken` contract.
- `<treasury-vault-proxy>` is the treasury vault proxy receiving `MINTER_ROLE`.

## Explorer Verification

The initial-stack flow saves enough metadata to verify every contract deployed by
the run without manually reconstructing constructor arguments.

On remote networks, the interactive deployment script can run this verification
automatically as its final step. Localhost runs skip explorer verification.

1. Set `ETHERSCAN_API_KEY` in your environment or `.env`.
2. Verify the latest run for an environment:

```bash
npm run verify:initial-stack -- --grvt-env testnet --latest
```

3. Or verify a specific saved run directory:

```bash
npm run verify:initial-stack -- --run-dir deployment-records/testnet/2026-095259Z-initial-stack-minh
```

Useful flags:

- `--dry-run`: print the verification plan without sending explorer requests
- `--force`: retry even if a contract is already verified

The script verifies:

- each Ignition deployment ID surfaced in the saved record
- the OpenZeppelin `ProxyAdmin` contracts for each transparent proxy

The extra `ProxyAdmin` verification matters because OpenZeppelin v5
`TransparentUpgradeableProxy` deploys its admin internally, so Ignition does not
track that admin as a standalone deployment.

## Related Runbooks

- For non-production mock Aave details: [aave-mock-deployment.md](aave-mock-deployment.md)
- For broader operational procedure: [runbook.md](runbook.md)
