# Vault and Gateways

## Metadata

- Audience: contributors, reviewers, operators
- Purpose: map the implemented contracts to the system model
- Canonical for: implemented component layout, native boundaries, bridge path wiring

## Implemented Contracts

- `GRVTL1TreasuryVault`: upgradeable core vault
- `GRVTL1TreasuryVaultViewModule`: fixed helper for heavy read paths
- `GRVTL1TreasuryVaultOpsModule`: fixed helper for heavy V2 mutation paths
- `NativeVaultGateway`: external ETH -> wrapped-native -> vault ingress
- `NativeBridgeGateway`: wrapped-native -> ETH bridge execution and failed-deposit recovery
- `YieldRecipientTreasury`: optional treasury boundary for direction-aware fee reimbursement
- `AaveV3Strategy`: legacy vault-only adapter for the Aave lane
- `AaveV3StrategyV2`: single-lane Aave V2 adapter
- `GsmStkGhoStrategy`: vault-only adapter for the `vaultToken -> GSM -> GHO -> stkGHO` lane

## Topology

```text
                                      +----------------------------------+
                                      |          Governance/Admin        |
                                      |   (DEFAULT_ADMIN, VAULT_ADMIN)   |
                                      +-----------------+----------------+
                                                        |
                                                        v
                         +--------------------------------------------------------------+
                         |                   GRVTL1TreasuryVault                        |
                         +----+---------------------------------------------------------+
                              |                     |                            |
         allocate/deallocate  |                     |                            | requestL2TransactionTwoBridges(...)
                              v                     v                            v
                     +----------------+   +--------------------+   +--------------------------+
                     | AaveV3Strategy |   | GsmStkGhoStrategy |   | BridgeHub + SharedBridge  |
                     +--------+-------+   +---------+---------+   +-------------+-------------+
                              |                     |                           ^
                              v                     v                           |
                           Aave V3          GSM -> GHO -> stkGHO        NativeBridgeGateway
```

## Strategy Path

Normal yield flow:

1. allocator calls `allocateVaultTokenToStrategy(vaultToken, strategy, amount)`
2. vault checks support, whitelist, cap, and pause rules
3. strategy pulls vault tokens and deploys them into the external venue
4. vault uses `strategyExposure(vaultToken)` for cap and harvest decisions
5. deallocation measures actual vault-side received balance delta instead of trusting strategy return values

Implemented strategy examples:

- [AaveV3Strategy](../../contracts/strategies/AaveV3Strategy.sol): documented in [../integrations/aave.md](../integrations/aave.md)
- [AaveV3StrategyV2](../../contracts/strategies/AaveV3StrategyV2.sol): documented in [../integrations/aave.md](../integrations/aave.md)
- [GsmStkGhoStrategy](../../contracts/strategies/GsmStkGhoStrategy.sol): documented in [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md)

### V2 Policy Layer

The upgraded vault carries both the legacy strategy surface and the new V2 policy-native surface.

For V2 lanes:

- the strategy is single-lane and exposes immutable transform metadata,
- V2 strategies are trusted implementations,
- the vault owns the authoritative tracked principal ledger for the lane,
- V2 entry cost basis uses strategy-reported `invested`, while measured vault deltas remain sanity checks only,
- the vault activates per-lane policy with `setStrategyPolicyConfig`,
- normal allocate, deallocate, and harvest paths enforce realized fee caps,
- harvest is a vault-side residual withdrawal through the same strategy exit surface,
- when a V2 lane is economically empty, final removal is an explicit admin cleanup step rather than an exact-token archival proof,
- there is no separate emergency unwind surface; operators choose deallocation order explicitly and then use the normal bridge path.

## L1 -> L2 Bridge Path

Normal top-up flow:

1. rebalancer calls `rebalanceNativeToL2(amount)` or `rebalanceErc20ToL2(token, amount)`
2. vault checks pause rules plus bridge eligibility
3. bridge execution cost is funded through base-token minting
4. ERC20 path submits the two-bridges request directly through `BridgeHub`
5. native path transfers wrapped-native plus the fee token to `NativeBridgeGateway`
6. `NativeBridgeGateway` unwraps, becomes the deposit sender, and submits the native bridge request

`supported` and `bridgeable` are intentionally separate:

- `supported` means the token is approved for vault custody and normal vault accounting
- `bridgeable` means the token is approved for the generic ERC20 shared-bridge path

This separation matters because some ERC20s may be safe to custody but unsafe to bridge through the generic path without a token-specific adapter.

There is no separate emergency bridge path. Incident-time L1 -> L2 movement is an operator workflow: deallocate the chosen lanes, unpause, then bridge idle funds through the normal native or ERC20 path.

## Native ETH Boundaries

The architecture intentionally keeps raw ETH out of normal vault accounting.

### Ingress

- planned external ETH enters through `NativeVaultGateway`
- the gateway wraps ETH into `wrappedNativeToken`
- the vault receives ERC20 balances, not raw ETH, for normal accounting
- integrators should use `depositToVault()` or a full-gas native `call`
- Solidity stipend-based `.transfer()` and `.send()` are intentionally unsupported on the receive path
- if unexpected ETH or ERC20 balances are stranded on `NativeVaultGateway`, vault admins can recover them with
  `sweepNative(recipient, amount)` or `sweepToken(token, recipient, amount)`

### Bridge execution

- native bridge intent uses explicit native methods
- the vault sources funds from wrapped-native balance
- `NativeBridgeGateway` unwraps and performs the native bridge send

### Failed native deposit recovery

- failed native deposits return to `NativeBridgeGateway`, not to the vault
- when a native deposit is submitted, `NativeBridgeGateway` snapshots the exact `sharedBridge` and refund sender for that bridge era
- recovery uses that recorded metadata, not whatever `bridgeHub` points to later
- recovery is atomic: the gateway claims the failed deposit, re-wraps the returned ETH, and sends wrapped-native back to the vault in one transaction
- the gateway accepts recovery ETH only from the refund sender expected for the active claim
- future native deposits can move to a new `bridgeHub`, but historical failed deposits still recover through their recorded bridge stack

### Harvest payout

- wrapped-native harvest pays the yield recipient in native ETH
- this is an explicit payout boundary, not a change in the vault's internal accounting model

## Why BaseToken Minting Exists

The bridge flow mints the GRVT bridge-proxy fee token to fund `mintValue` for the private-chain bridge model. Without the required mint permission in the bridge stack, L1 -> L2 top-ups fail even if the vault has enough bridged asset balance.

## Deployment Wiring

The vault core deployment path is:

1. deploy `VaultStrategyOpsLib`
2. deploy `VaultBridgeLib`
3. deploy `GRVTL1TreasuryVaultViewModule`
4. deploy `GRVTL1TreasuryVaultOpsModule`
5. deploy `GRVTL1TreasuryVault` implementation with the module addresses
6. deploy `TransparentUpgradeableProxy` and initialize the vault proxy

The native gateway deployment path is:

1. deploy `NativeVaultGateway`
2. deploy `NativeBridgeGateway` implementation
3. deploy `TransparentUpgradeableProxy` for `NativeBridgeGateway`
4. initialize the proxy with wrapped-native token, fee token, bridge hub, and vault
5. set the vault's `nativeBridgeGateway`

Operational deployment steps live in [../operations/runbook.md](../operations/runbook.md).

## Related Docs

- [../concepts/system-overview.md](../concepts/system-overview.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [../design-decisions/10-static-vault-modules-for-bytecode-limit.md](../design-decisions/10-static-vault-modules-for-bytecode-limit.md)
- [../design-decisions/05-native-boundary-and-gateway-split.md](../design-decisions/05-native-boundary-and-gateway-split.md)
