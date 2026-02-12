# GRVT L1 DeFi Vault Threat Model

## Scope

- `GRVTDeFiVault` on Ethereum L1.
- `AaveV3Strategy` (USDT-first).
- `ZkSyncNativeBridgeAdapter`.
- Privileged operators: admin, allocator, rebalancer, pauser.

## Trust Assumptions

- Governance/admin keys are controlled by a secure multisig.
- Rebalancer/allocator automation is operated by trusted infrastructure.
- Aave v3 and bridge/custody integrations are externally managed dependencies.
- Supported token contracts are reviewed and approved before whitelisting.

## Top Risks and Mitigations

1. Privileged key compromise
- Risk: attacker can redirect bridge adapter/recipient, drain via rebalance, or mutate role assignments.
- Mitigations: multisig ownership, hardware-key policies, timelock for high-impact config changes, separate hot/cold duties, monitoring alerts for role/config mutations, incident-gated use of emergency sends.

2. External protocol risk (Aave or bridge/custody outage)
- Risk: inability to deallocate/bridge during market stress.
- Mitigations: keep idle reserve on L1, emergency send path, bounded strategy fanout for predictable unwind gas, pause to halt new risky outflows.
- Note: `emergencySendToL2` intentionally bypasses `rebalanceMaxPerTx` and `rebalanceMinDelay`; blast-radius control is operational (RBAC, multisig governance, monitoring), not per-tx cap enforcement in emergency mode.

3. Reentrancy and callback abuse
- Risk: malicious strategy/token callback during allocate/deallocate/rebalance.
- Mitigations: `ReentrancyGuard` on state-changing flows, checks-effects-interactions ordering, strict role and whitelist gating.

4. Token non-compliance and transfer edge cases
- Risk: tokens with non-standard approval/transfer behavior cause silent failures.
- Mitigations: `SafeERC20`, `forceApprove`, adversarial tests for false-return and fee-on-transfer behavior.

5. Misconfiguration risk
- Risk: wrong adapter, wrong L2 recipient, unsupported token, or broken role setup.
- Mitigations: strict non-zero/address validation, explicit role bootstrap procedure, post-deploy smoke checks and event monitoring.

## Residual Risks

- Emergency operations are still dependent on chain liveness and gas market conditions.
- Emergency operations can move larger-than-normal per-tx amounts when authorized operators invoke emergency flows.
- DeFi protocol insolvency or governance failures are out of vault-contract control.
- Human operational errors remain possible without strict runbooks and change controls.
