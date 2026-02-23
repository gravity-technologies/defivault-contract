# Scenario 1: Native ETH and Wrapped-Native Handling

## What This Is For

This scenario explains how native ETH intent is handled without introducing native ETH as a strategy accounting domain.

Primary users:

- backend engineers wiring rebalance/allocate calls
- operators handling bridge and treasury incidents

## Design Reason (Why We Enforce Wrapped-Native Internally)

- In this vault's zkSync bridge path, explicit WETH bridge-out is not supported: native branch uses ETH and ERC20 branch is for non-wrapped-native ERC20 tokens.
- To keep strategy/accounting code simpler and deterministic, vault and strategy domains are enforced as ERC20-only.
- So native inflow invariant is:
  - external ETH must be wrapped before vault accounting/strategy flows.
  - `NativeToWrappedIngress` is the canonical wrapper that enforces this invariant.

## Most Common Flow (Day-to-Day)

Goal: move funds through vault using canonical wrapped-native ERC20.

1. External ETH enters through `NativeToWrappedIngress`.
2. Ingress wraps ETH into wrapped-native token and forwards to vault.
3. Vault now holds canonical wrapped-native idle balance.
4. Allocation/deallocation uses sentinel `address(0)` at API boundary, but internal accounting uses wrapped-native token address.

Why this is the default:

- one accounting domain for strategy and principal tracking
- avoids ambiguous native-balance behavior in strategy paths

## Ad-hoc / Incident Flows

### 1) Direct ETH sent to vault

- Vault `receive()` accepts ETH only from wrapped-native token contract (unwrap callback).
- Any other direct sender reverts.

### 2) L1 -> L2 native bridge path

- Caller uses boundary sentinel (`address(0)`) on rebalance/emergency call.
- Vault canonicalizes internally, then unwraps at bridge boundary and uses native branch.
- Passing wrapped-native token directly to rebalance/emergency boundary APIs is rejected.
- Why: this bridge integration path does not support explicit wrapped-native bridge-out; native intent must be sent as ETH.

### 3) Wrapped-native harvest payout

- Harvest input token is canonical wrapped-native token (not sentinel).
- Vault deallocates wrapped-native from strategy.
- Vault unwraps and pays treasury in ETH.
- Non-payable treasury reverts with `NativeTransferFailed`.
- Why ETH payout (instead of forwarding wrapped-native):
  - lower operational overhead for treasury (no extra unwrap step),
  - ETH can be reused directly for transaction gas and operational payments.

### 4) Forced ETH in vault

- Forced ETH (e.g. `SELFDESTRUCT`) can still appear.
- Recovery path is admin-only `sweepNative(amount)` to treasury.

## Why This Is Complex

- UX wants native intent (`address(0)`), but accounting requires ERC20 keys.
- Bridge/native and strategy/harvest boundaries are different conversion points.
- Security requires strict ingress and reentrancy-safe native payout behavior.

## Debug Checklist

- Did caller use sentinel on boundary APIs (and not wrapped-native token directly)?
- Is `msg.value == 0` on rebalance/emergency calls?
- For harvest payout issues: is treasury payable?
- For unexpected ETH in vault: was it forced ETH requiring `sweepNative`?
