# Scenario 1: Native ETH, Wrapped Native, and the Two Gateways

## What This Is For

This scenario explains how native ETH moves through the system and why the vault keeps its token-domain logic ERC20-only.

Primary users:

- engineers wiring native deposit, harvest, and bridge flows
- operators handling bridge and treasury incidents

## Core Rule

The vault is not the normal entrypoint for raw ETH.

- External ETH must go through `NativeVaultGateway`.
- Native L1 -> L2 bridge sends must go through `NativeBridgeGateway`.
- Vault and strategy accounting use wrapped native (`wrappedNativeToken`) as the ERC20 form of native exposure.

In practice, that means native ETH is handled only at explicit conversion points. The vault should not be treated as a general-purpose ETH receiver.

## The Two Gateways

### `NativeVaultGateway`

`NativeVaultGateway` is the ETH entry contract.

- It accepts ETH from users or operators.
- It wraps that ETH into `wrappedNativeToken`.
- It forwards the wrapped token to the vault.

This keeps planned inbound flows in ERC20 form before the vault ever sees the funds.

### `NativeBridgeGateway`

`NativeBridgeGateway` is the ETH bridge contract.

- The vault sends wrapped native and base token to this gateway.
- The gateway unwraps wrapped native into ETH for the native bridge path.
- The gateway is also the recovery point for failed native bridge deposits returned on L1.
- Recovered ETH is wrapped again before funds go back to the vault.

This keeps native bridge execution and failed-deposit recovery out of the vault itself.

## Most Common Flow (Day-to-Day)

Goal: move native value through the system without introducing raw ETH into the vault's token-domain APIs.

1. External ETH enters through `NativeVaultGateway`.
2. `NativeVaultGateway` wraps ETH into `wrappedNativeToken`.
3. The gateway transfers wrapped native to the vault.
4. The vault now holds wrapped-native idle balance.
5. Strategy allocation and accounting use the wrapped-native token address, not ETH.

Why this is the default:

- strategy code stays ERC20-only
- cost basis and TVL tracking stay token-address based
- bridge and recovery ETH handling stays isolated in the gateway layer

## Ad-hoc / Incident Flows

### 1) Direct ETH sent to the vault

- Direct external ETH is not a supported ingress path.
- The vault should not be used as an ETH receiver in normal operation.
- The vault `receive()` hook exists only for internal wrapped-native withdraw callbacks.
- Any other planned ETH flow should be routed through `NativeVaultGateway`.

### 2) L1 -> L2 native bridge path

- Native bridge sends use the explicit native methods: `rebalanceNativeToL2` and `emergencyNativeToL2`.
- Internally, the vault sources funds from wrapped-native balance.
- The vault transfers wrapped native and base token to `NativeBridgeGateway`.
- `NativeBridgeGateway` unwraps and submits the native bridge request.

Do not use the ERC20 bridge path with the wrapped-native token for native sends.

### 3) Failed native bridge deposit recovery

- Failed native deposits are recovered back to `NativeBridgeGateway`, not to the vault.
- `NativeBridgeGateway` wraps the recovered ETH back into `wrappedNativeToken`.
- The gateway returns wrapped native to the vault.

This keeps native recovery consistent with the ERC20-only vault accounting model.

### 4) Wrapped-native harvest payout

- Harvest input is the wrapped-native vault token.
- The vault deallocates wrapped native from the strategy.
- The vault unwraps and pays the yield recipient in ETH.
- A non-payable treasury reverts with `NativeTransferFailed`.

This is a payout boundary, not a change to the vault's token-domain model.

### 5) Forced ETH in the vault

- Forced ETH can still appear through EVM edge cases such as `SELFDESTRUCT`.
- That ETH is outside the planned accounting flow.
- Recovery path is admin-only `sweepNativeToYieldRecipient(amount)`.

## Why This Can Be Confusing

- Native value enters through one gateway and leaves through another.
- The vault stores native exposure as wrapped native, but bridge and payout edges still use ETH.
- The vault has a `receive()` hook, but that does not make it a supported ETH ingress contract.

## Debug Checklist

- Did external ETH go through `NativeVaultGateway` rather than directly to the vault?
- Did native bridge sends use `rebalanceNativeToL2` or `emergencyNativeToL2` rather than the ERC20 bridge path?
- Did failed native deposit recovery terminate at `NativeBridgeGateway`?
- For harvest payout issues: is the treasury payable?
- For unexpected ETH in the vault: was it forced ETH requiring `sweepNativeToYieldRecipient`?
