# Vault Upgrades And V2 Policy

## Metadata

- Audience: operators, deployers, reviewers
- Purpose: define the upgrade checks and the operator activation steps for V2 lanes
- Canonical for: vault upgrade procedure, V2 policy activation, and treasury preconditions

## Scope

Use this page when:

- preparing a vault upgrade,
- adding a new V2 strategy lane,
- turning on reimbursement for a V2 lane,
- checking whether a lane should be considered live under the new policy.

This page is about the current vault lineage. It does not describe the initial legacy deployment shape.

## Pre-Upgrade Checks

Run these before preparing or executing a vault upgrade:

```bash
npm exec hardhat compile
npm run size:check:vault
npm exec hardhat test test/unit/VaultUpgrade.test.ts
```

Why these matter:

- `size:check:vault` confirms the implementation still fits under the deploy limit,
- `VaultUpgrade.test.ts` proves the current implementation can upgrade a legacy-compatible vault and still support both legacy and V2 lanes.

## What The Upgrade Task Deploys

`upgrade:vault` no longer deploys only one implementation contract.

It deploys:

- `VaultStrategyOpsLib`
- `VaultBridgeLib`
- `GRVTL1TreasuryVaultViewModule`
- `GRVTL1TreasuryVaultOpsModule`
- `GRVTL1TreasuryVault` implementation

Then it upgrades the existing proxy to that implementation.

Record all of those addresses in the operation record, not just the implementation and proxy.

## Upgrade Command

```bash
npx hardhat upgrade:vault -- \
  --network <network> \
  --parameters tasks/parameters/<env>/vault-upgrade.json5
```

Behavior:

- if `requiresMultisig: true`, the task prepares calldata and writes the record without executing,
- if `requiresMultisig: false`, the task executes the upgrade directly with the signer.

## Expected Post-Upgrade State

After the upgrade:

- vault roles and token config should be unchanged,
- legacy `IYieldStrategy` lanes should still deallocate and report correctly,
- V2 lanes can be added without changing the legacy lanes,
- module addresses are fixed inside the new implementation and are not governance-tunable after deployment.

## V2 Lane Activation

Whitelisting a V2 strategy is not enough to make it live under policy.

The activation sequence is:

1. deploy the V2 lane,
2. whitelist it on the vault with `setVaultTokenStrategyConfig`,
3. make sure `yieldRecipient` is a compatible treasury,
4. authorize the vault on the treasury,
5. fund the treasury with enough of the vault token for tracked entry and exit reimbursement,
6. set `StrategyPolicyConfig` on the vault,
7. record the final lane policy in the operation record.

Current gap:

- this repo does not yet wrap `setStrategyPolicyConfig` in a dedicated Hardhat task or Ignition module,
- today that call should be prepared as direct admin or multisig calldata against the vault proxy.

Operator note:

- normal V2 `deallocate*` calls recover tracked principal,
- residual value stays on `harvestYieldFromStrategy`,
- `deallocateAll` is the impairment recognition path for V2; there is no separate write-down ceremony,
- V2 entry accounting trusts strategy-reported `invested`, while the vault still measures balance changes to reject impossible results.
- if a trusted V2 lane takes a real impairment, governance should:
  - de-whitelist the lane so it is withdraw-only,
  - use `deallocateAll` to realize the loss and zero tracked cost basis,
  - harvest any residual value that remains after tracked principal is cleared.

Example calldata shape:

```bash
cast calldata \
  "setStrategyPolicyConfig(address,address,(uint24,uint24,bool))" \
  <vaultToken> \
  <strategy> \
  "(<entryCapHundredthBps>,<exitCapHundredthBps>,<policyActive>)"
```

## Recommended Current V2 Policies

### Aave V2

Use this for `AaveV3StrategyV2`:

- `entryCapHundredthBps = 0`
- `exitCapHundredthBps = 0`
- tracked entry and exit reimbursement comes from treasury configuration, not per-lane booleans
- `policyActive = true`

### SGHO

Use this for `SGHOStrategy`:

- `entryCapHundredthBps = 1` (`0.01 bps`)
- `exitCapHundredthBps = 1200` (`12 bps`)
- `policyActive = true`

Treasury preconditions for the SGHO lane:

- `yieldRecipient` must implement the reimbursement treasury interface,
- the vault must be authorized on that treasury,
- the treasury must hold enough of the vault token before reimbursing tracked flows are relied on.

Treasury rotation does not pre-validate lane tuples anymore. It only checks that the replacement treasury:

- implements the reimbursement treasury interface,
- authorizes the vault.

Treasury funding remains an operator responsibility.

## Incident Operations

Do not assume treasury reimbursement is bridgeable liquidity.

There is no separate emergency unwind surface.

Incident-time L2 restoration is an operator workflow:

- deallocate the lanes you want to unwind,
- keep reimbursement and fee-cap semantics identical to normal exits,
- unpause when ready to bridge,
- use the normal native or ERC20 rebalance path.

V2 finalization is administrative cleanup for an economically empty lane. It is not a strict proof that every exact token balance has been erased.

## Read Next

- [runbook.md](runbook.md)
- [../concepts/v2-strategy-brief.md](../concepts/v2-strategy-brief.md)
- [../concepts/v2-accounting-walkthrough.md](../concepts/v2-accounting-walkthrough.md)
- [../design-decisions/09-legacy-vault-upgrade-path.md](../design-decisions/09-legacy-vault-upgrade-path.md)
- [../design-decisions/10-static-vault-modules-for-bytecode-limit.md](../design-decisions/10-static-vault-modules-for-bytecode-limit.md)
- [../design-decisions/12-remove-emergency-bridge-surface.md](../design-decisions/12-remove-emergency-bridge-surface.md)
