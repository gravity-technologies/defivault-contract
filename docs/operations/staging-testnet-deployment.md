# Aave Mock Deployment Runbook

## Metadata

- Audience: operators and contributors deploying `staging` or `testnet`
- Purpose: deploy the vault stack against a controllable Aave-like mock instead of a public Aave market
- Canonical for: mock Aave prerequisite order, parameter-file wiring, and environment-specific rollout steps

## Scope

Use this runbook when:

- the target network is Ethereum Sepolia through this repo's `testnet` Hardhat network
- the vault should integrate with a supply/withdraw-only Aave-shaped surface you control
- the underlying asset is a custom test token address that public Aave does not support

This runbook uses the repository's existing mock contracts:

- `MockAaveV3Pool`
- `MockAaveV3AToken`
- optional mock infrastructure from the smoke test path:
  - `MockERC20`
  - `MockWETH`
  - `MockL1ZkSyncBridgeAdapter`

## Important Environment Note

This repository currently defines one remote Hardhat network alias: `testnet`.

- `ignition/parameters/staging/*` and `ignition/parameters/testnet/*` are separate parameter sets
- both are deployed with `--network testnet`
- if you want `staging` and `testnet` isolated from each other, deploy separate mock contracts and keep the parameter files distinct

## Prerequisites

1. Export network access for Sepolia:

   ```bash
   export TESTNET_RPC_URL="<sepolia_rpc_url>"
   export TESTNET_PRIVATE_KEY="<deployer_private_key>"
   ```

2. Install dependencies and compile:

   ```bash
   npm install
   npm run compile
   ```

3. Choose the environment directory you are preparing:

   - `ignition/parameters/staging`
   - `ignition/parameters/testnet`

4. Decide whether the deployment should reuse existing Sepolia infrastructure or mock all external dependencies.

Use real Sepolia addresses if you already have a valid bridge stack and wrapped native token.

Use mocks for a fully controlled environment if you do not want any dependency on live bridge or token infrastructure.

## Deployment Order

Deploy in this order:

1. External prerequisites
2. Vault core
3. Strategy core
4. Vault token support
5. Vault token strategy binding
6. Operational roles
7. Yield-recipient timelock
8. Native gateways
9. Post-deploy verification

## 1. Deploy External Prerequisites

The exact mock deployment order used in the smoke test is implemented in `scripts/ci/deployment-smoke.ts`. For `staging` or `testnet`, deploy the contracts below in the same order and record every address.

### Required Aave Mock Contracts

Deploy:

1. `MockERC20` for the custom underlying token
2. `MockAaveV3Pool(underlyingToken)`
3. `MockAaveV3AToken(underlyingToken, aavePool, "<name>", "<symbol>")`
4. call `MockAaveV3Pool.setAToken(aToken)`

Recommended values:

- underlying token name: your team-facing token name, for example `Staging USDT`
- underlying token symbol: a symbol that makes the environment obvious, for example `sUSDT` or `tUSDT`
- underlying token decimals: match the real asset you are modeling, for example `6` for USDT-like behavior
- aToken name: for example `Aave Mock Staging USDT`
- aToken symbol: for example `amUSDT`

### Optional Fully Mocked Dependencies

If this deployment should avoid live Sepolia bridge infrastructure as well, also deploy:

1. `MockL1ZkSyncBridgeAdapter`
2. `MockERC20` as `grvtBridgeProxyFeeToken`
3. `MockWETH` as `wrappedNativeToken`

If you already have valid Sepolia addresses for:

- `bridgeHub`
- `grvtBridgeProxyFeeToken`
- `wrappedNativeToken`

you may reuse those and only mock the Aave side.

### Address Checklist

Record:

- `underlyingToken`
- `aavePool`
- `aToken`
- `bridgeHub`
- `grvtBridgeProxyFeeToken`
- `wrappedNativeToken`

## 2. Fill `vault-core.json5`

Update:

- `ignition/parameters/<env>/vault-core.json5`

Set:

- `deployAdmin`
- `bridgeHub`
- `grvtBridgeProxyFeeToken`
- `l2ChainId`
- `l2ExchangeRecipient`
- `wrappedNativeToken`
- `yieldRecipient`

Notes:

- `wrappedNativeToken` is independent from the Aave mock underlying token
- `yieldRecipient` must be non-zero and must not equal `deployAdmin`

Deploy:

```bash
npm run deploy:vault -- \
  --network testnet \
  --parameters ignition/parameters/<env>/vault-core.json5
```

Record:

- vault implementation address
- vault proxy address
- vault ProxyAdmin address
- deployment transaction hash

## 3. Fill `strategy-core.json5`

Update:

- `ignition/parameters/<env>/strategy-core.json5`

Set:

- `vaultProxy`: the deployed vault proxy from step 2
- `proxyAdminOwner`
- `aavePool`: the `MockAaveV3Pool` address
- `underlyingToken`: the custom underlying token address
- `aToken`: the matching `MockAaveV3AToken` address
- `strategyName`

Recommended strategy names:

- `AAVE_V3_MOCK_USDT_STAGING`
- `AAVE_V3_MOCK_USDT_TESTNET`

Why the triple must match:

- `AaveV3Strategy.initialize(...)` validates that `aToken.UNDERLYING_ASSET_ADDRESS() == underlyingToken`
- it also validates that `aToken.POOL() == aavePool`
- if you mix addresses from different deployments, initialization reverts with `InvalidATokenConfig`

Deploy:

```bash
npm run deploy:strategy -- \
  --network testnet \
  --parameters ignition/parameters/<env>/strategy-core.json5
```

Record:

- strategy implementation address
- strategy proxy address
- strategy ProxyAdmin address
- deployment transaction hash

## 4. Enable the Vault Token

Update:

- `ignition/parameters/<env>/vault-token-config.json5`

Set:

- `vaultProxy`
- `vaultToken`: the mock underlying token address
- `supported: true`

Deploy:

```bash
npm run config:vault-token -- \
  --network testnet \
  --parameters ignition/parameters/<env>/vault-token-config.json5
```

## 5. Bind the Strategy to the Vault Token

Update:

- `ignition/parameters/<env>/vault-token-strategy.json5`

Set:

- `vaultProxy`
- `strategyProxy`
- `vaultToken`: the mock underlying token address
- `vaultTokenSupported: true`
- `vaultTokenStrategyWhitelisted: true`
- `strategyCap`

Operational recommendation:

- start with a small cap such as `1000000n` in token base units
- raise the cap only after you verify `allocate` and `deallocate` behavior on-chain

Deploy:

```bash
npm run deploy:vault-token-strategy -- \
  --network testnet \
  --parameters ignition/parameters/<env>/vault-token-strategy.json5
```

## 6. Bootstrap Roles

Update:

- `ignition/parameters/<env>/roles-bootstrap.json5`

Set:

- `vaultProxy`
- `allocator`
- `rebalancer`
- `pauser`

Deploy:

```bash
npm run roles:bootstrap -- \
  --network testnet \
  --parameters ignition/parameters/<env>/roles-bootstrap.json5
```

## 7. Bootstrap Yield-Recipient Timelock

Update:

- `ignition/parameters/<env>/yield-recipient-bootstrap.json5`

Set:

- `vaultProxy`
- `minDelay`
- `proposers`
- `executors`
- `admin`

Deploy:

```bash
npm run deploy:yield-recipient-timelock -- \
  --network testnet \
  --parameters ignition/parameters/<env>/yield-recipient-bootstrap.json5
```

## 8. Deploy Native Gateways

Update:

- `ignition/parameters/<env>/native-gateways.json5`

Set:

- `vaultProxy`
- `proxyAdminOwner`
- `wrappedNativeToken`
- `grvtBridgeProxyFeeToken`
- `bridgeHub`

Deploy:

```bash
npm run deploy:native-gateways -- \
  --network testnet \
  --parameters ignition/parameters/<env>/native-gateways.json5
```

Record:

- `NativeVaultGateway`
- `NativeBridgeGatewayImplementation`
- `NativeBridgeGatewayProxy`
- native gateway ProxyAdmin address

## 9. Post-Deploy Verification

Run these checks before operators start using the environment:

1. Confirm the vault is unpaused.
2. Confirm expected role holders.
3. Confirm `wrappedNativeToken`, `bridgeHub`, `grvtBridgeProxyFeeToken`, `l2ChainId`, and `l2ExchangeRecipient`.
4. Confirm the mock underlying token is enabled as a supported vault token.
5. Confirm the strategy is whitelisted and capped as expected.
6. Confirm `AaveV3Strategy` points to the deployed mock `aavePool`, `underlyingToken`, and `aToken`.

### Functional Smoke Checks

Run at least one controlled end-to-end cycle:

1. Mint the mock underlying token to the vault funding address.
2. Transfer or deposit that token into the vault.
3. Call `allocateVaultTokenToStrategy(vaultToken, strategy, amount)`.
4. Confirm the strategy holds mock `aToken` balance.
5. Call `deallocateVaultTokenFromStrategy(vaultToken, strategy, amount)`.
6. Confirm underlying tokens return to the vault.

Optional yield simulation:

1. Call `MockAaveV3Pool.accrueYield(strategy, amount)`.
2. Confirm `strategyExposure(vaultToken)` increases accordingly.
3. Run the relevant harvest or accounting checks for your environment.

## Environment-Specific Execution

Use the same command shape for both environments and only change `<env>`.

### Staging

```bash
npm run deploy:vault -- \
  --network testnet \
  --parameters ignition/parameters/staging/vault-core.json5
```

### Testnet

```bash
npm run deploy:vault -- \
  --network testnet \
  --parameters ignition/parameters/testnet/vault-core.json5
```

Apply that same `<env>` substitution to:

- `strategy-core.json5`
- `vault-token-config.json5`
- `vault-token-strategy.json5`
- `roles-bootstrap.json5`
- `yield-recipient-bootstrap.json5`
- `native-gateways.json5`

## Recommended Separation Policy

If `staging` and `testnet` are meant to simulate different environments, keep these separate per environment:

- mock underlying token
- mock Aave pool
- mock aToken
- strategy proxy
- vault proxy

It is acceptable to reuse common Sepolia infrastructure such as:

- a shared `wrappedNativeToken`
- a shared `bridgeHub`
- a shared `grvtBridgeProxyFeeToken`

only if that matches your operational model and does not blur environment boundaries.

## Failure Modes

Watch for these common setup mistakes:

- `InvalidATokenConfig` during strategy deployment:
  - `aToken` does not belong to the selected `aavePool`
  - `aToken` was deployed against a different underlying token
- vault token configuration succeeds but allocation fails:
  - the vault token address differs from the mock underlying token used by the strategy
- native gateway deployment succeeds but native flows fail:
  - `wrappedNativeToken` was left as zero or pointed at a non-wrapper contract
- cross-environment confusion:
  - `staging` parameter files accidentally reference `testnet` mock addresses or vice versa

## References

- `contracts/mocks/MockAaveV3Pool.sol`
- `contracts/mocks/MockAaveV3AToken.sol`
- `contracts/strategies/AaveV3Strategy.sol`
- `scripts/ci/deployment-smoke.ts`
- `docs/operations/runbook.md`
