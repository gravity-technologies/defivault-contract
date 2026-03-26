# Vault and Gateways

## Metadata

- Audience: contributors, reviewers, operators
- Purpose: map the implemented contracts to the system model
- Canonical for: implemented component layout, native boundaries, bridge path wiring

## Implemented Contracts

- `GRVTL1TreasuryVault`: upgradeable core vault
- `NativeVaultGateway`: external ETH -> wrapped-native -> vault ingress
- `NativeBridgeGateway`: wrapped-native -> ETH bridge execution and failed-deposit recovery
- `AaveV3Strategy`: current implemented vault-only strategy adapter

## Topology

```text
                         +----------------------------------+
                         |          Governance/Admin        |
                         |   (DEFAULT_ADMIN, VAULT_ADMIN)   |
                         +-----------------+----------------+
                                           |
                                           v
                         +---------------------------+
                         |    GRVTL1TreasuryVault    |
                         +----+-----------------+----+
                              |                 |
         allocate/deallocate  |                 | requestL2TransactionTwoBridges(...)
                              v                 v
                     +----------------+   +---------------------------+
                     | AaveV3Strategy |   | BridgeHub + SharedBridge  |
                     +--------+-------+   +-------------+-------------+
                              |                           ^
                              v                           |
                           Aave V3                NativeBridgeGateway
```

## Strategy Path

Normal yield flow:

1. allocator calls `allocateVaultTokenToStrategy(vaultToken, strategy, amount)`
2. vault checks support, whitelist, cap, and pause rules
3. strategy pulls vault tokens and deploys them into the external venue
4. vault uses `strategyExposure(vaultToken)` for cap and harvest decisions
5. deallocation measures actual vault-side received balance delta instead of trusting strategy return values

The current implemented strategy is [AaveV3Strategy](../../contracts/strategies/AaveV3Strategy.sol). The current Aave-specific behavior is documented in [../integrations/aave.md](../integrations/aave.md).

## L1 -> L2 Bridge Path

Normal top-up flow:

1. rebalancer calls `rebalanceNativeToL2(amount)` or `rebalanceErc20ToL2(token, amount)`
2. vault checks pause and support rules
3. bridge execution cost is funded through base-token minting
4. ERC20 path submits the two-bridges request directly through `BridgeHub`
5. native path transfers wrapped-native plus the fee token to `NativeBridgeGateway`
6. `NativeBridgeGateway` unwraps, becomes the deposit sender, and submits the native bridge request

Emergency top-up flow uses `emergencyNativeToL2` and `emergencyErc20ToL2`. These bypass normal pause/support restrictions but remain role-gated.

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
- the gateway re-wraps recovered ETH and returns wrapped-native to the vault

### Harvest payout

- wrapped-native harvest pays the yield recipient in native ETH
- this is an explicit payout boundary, not a change in the vault's internal accounting model

## Why BaseToken Minting Exists

The bridge flow mints the GRVT bridge-proxy fee token to fund `mintValue` for the private-chain bridge model. Without the required mint permission in the bridge stack, L1 -> L2 top-ups fail even if the vault has enough bridged asset balance.

## Deployment Wiring

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
- [../design-decisions/native-boundary-and-gateway-split.md](../design-decisions/native-boundary-and-gateway-split.md)
