# Initial Stack Deployment

## Metadata

- Audience: operators and contributors deploying a brand-new DefiVault stack
- Purpose: explain the interactive initial-stack deployment flow and how it selects mock Aave versus live Aave
- Canonical for: `scripts/deploy/deploy-initial-stack-interactive.ts`, environment selection, and operator expectations

## Environment Policy

This repository uses two Aave modes for the interactive initial-stack deployment:

- `staging` and `testnet`: deploy `MockAaveV3Pool` and `MockAaveV3AToken`
- `production`: use the configured live Aave pool and aToken from `ignition/parameters/production/strategy-core.json5`

The non-production environments use mock Aave because GRVT supplies its own underlying token in those flows. In practice that means the vault and strategy are often wired against a GRVT-controlled USDT or other test asset address, not a public Aave reserve address. The mock contracts provide the Aave-shaped surface needed by `AaveV3Strategy` without requiring public Aave support for that token.

Production is different:

- the underlying token, `aavePool`, and `aToken` must be live addresses
- Step 1 validates those live Aave addresses instead of deploying mocks
- production should be run against Ethereum mainnet, not Sepolia

## Script

Use:

```bash
npm run deploy:initial-stack:interactive
```

For localhost:

```bash
npm run deploy:initial-stack:interactive:local
```

## Choosing The GRVT Environment

Remote runs prompt for the GRVT environment unless `GRVT_ENV` is already set:

```bash
GRVT_ENV=staging npm run deploy:initial-stack:interactive
GRVT_ENV=testnet npm run deploy:initial-stack:interactive
GRVT_ENV=production npm run deploy:initial-stack:interactive
```

Local mode defaults to `staging` and reuses `smoke-artifacts/outputs/prerequisites.json`. Local mode is only intended for the mock-Aave environments.

## What The Script Does

The script:

1. resolves the GRVT environment and Aave mode
2. runs a preflight check for chain id, deployer, balance, parameter directory, and local smoke prerequisites
3. collects or reuses parameter values, with grouped prompts for common defaults
4. writes per-run parameter files under `deployment-artifacts/initial-stack-interactive/<env>/<network>/<runId>/params`
5. executes the initial stack deployment step-by-step with Ignition
6. writes `manifest.json`, `summary.md`, and per-step stdout/stderr logs

## Artifacts

Each run is stored under:

```text
deployment-artifacts/initial-stack-interactive/<grvt-env>/<network>/<runId>/
```

Important files:

- `manifest.json`: machine-readable run state and resolved parameters
- `summary.md`: operator summary of steps and key addresses
- `params/*.generated.json5`: the generated per-run parameter files
- `logs/*.stdout.log` and `logs/*.stderr.log`: per-step command output

## Related Runbooks

- For non-production mock Aave details: [aave-mock-deployment.md](aave-mock-deployment.md)
- For broader operational procedure: [runbook.md](runbook.md)
