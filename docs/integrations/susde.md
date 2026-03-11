# sUSDe (Ethena) Integration Path

## Scope

As of March 5, 2026, this document is a point-in-time design evaluation for integrating Ethena sUSDe into the current vault/strategy model:

- Vault: `contracts/vault/GRVTL1TreasuryVault.sol`
- Adapter interface: `contracts/interfaces/IYieldStrategy.sol`

## Suitability

Integration is feasible, with one key constraint:

- the vault expects synchronous `deallocate` behavior (immediate USDe back to vault),
- while `StakedUSDeV2` supports an async cooldown mode.

So there are two viable modes:

- cooldown-off mode (`cooldownDuration == 0`): simple and aligned with current vault semantics,
- cooldown-on mode (`cooldownDuration > 0`): requires async state handling inside adapter.

## Protocol Facts (researched)

From Ethena docs and verified code at the time of writing:

- Mainnet staking/sUSDe contract: `0x9d39a5de30e57443bff2a8307a4256c8797a3497`.
- `StakedUSDeV2` is ERC4626-like with reward vesting.
- When cooldown is on, unstaking uses `cooldownAssets`/`cooldownShares` then `unstake`.
- `withdraw`/`redeem` are gated by cooldown-off checks.
- Cooldown duration is admin-configurable up to 90 days.
- Staking contract includes restriction/blacklist roles (operational risk for treasury/adapter addresses).

## Cooldown Mode Explained

In `StakedUSDeV2`, cooldown mode turns unstaking into a two-step process:

- `cooldownDuration == 0`: direct `withdraw/redeem` is enabled (synchronous exit).
- `cooldownDuration > 0`: direct `withdraw/redeem` is disabled; users must:
  1. start cooldown via `cooldownAssets` or `cooldownShares`,
  2. wait until cooldown maturity,
  3. call `unstake` to receive USDe.

For this vault architecture, the impact is direct:

- current `deallocate` and `deallocateAll` accounting expects USDe to return to the vault immediately,
- the current emergency withdraw path also expects immediate pullback,
- therefore cooldown-on adds delayed liquidity behavior that the current vault flow does not model directly.

Concrete example:

- If cooldown is 7 days and deallocation is requested on March 4, 2026, funds are normally claimable around March 11, 2026.
- During that period, immediate deallocation can return `0` even though economic exposure still exists.

Sources:

- https://docs.ethena.fi/solution-design/key-addresses
- https://docs.ethena.fi/solution-design/staking-usde
- https://docs.ethena.fi/solution-design/staking-usde/staking-key-functions
- https://docs.ethena.fi/solution-design/overview/github-overview
- https://etherscan.io/address/0x9d39a5de30e57443bff2a8307a4256c8797a3497

## Mapping to Current Vault Model

For this repository, model sUSDe as:

- vault token: `USDe`,
- receipt/component token: `sUSDe` (non-vault token excluded from tracked-token discovery but still available through per-token reporting),
- reward tokens: excluded from V1 accounting/reporting.

Recommended adapter behavior:

- `positionBreakdown(USDe)`:
  - include `sUSDe` as `InvestedPosition`,
  - optionally include residual `USDe` as `UninvestedToken`.
- `exactTokenBalance(sUSDe)`:
  - include `sUSDe` balance for exact-token query support.
- `strategyExposure(USDe)`:
  - use `previewRedeem(sUSDeBalance)` (or equivalent) + residual `USDe`.
- unsupported tokens:
  - `exactTokenBalance(token)` returns `0`,
  - `positionBreakdown(token)` returns empty,
  - `strategyExposure(token)` returns `0` and does not revert.
- vault-token rules:
  - strategy APIs use ERC20 vault tokens.
  - native sentinel `address(0)` is not a strategy token key.

## Option A (Recommended): Cooldown-Off Only

Assumption:

- strategy requires `cooldownDuration == 0` during operation.

Flow:

- `allocate(USDe, amount)`: vault -> adapter `transferFrom`, adapter stakes to sUSDe.
- `deallocate(USDe, amount)`: immediate `withdraw/redeem`, transfer USDe back to vault.
- `deallocateAll(USDe)`: full immediate redeem/withdraw.

Why this fits current vault:

- vault deallocation accounting is immediate balance delta based,
- emergency unwind expects immediate pullback,
- no pending-claim state is required.

## Option B: Cooldown-On Support (Async)

Needed only if cooldown can be non-zero during runtime.

Adapter must add state machine logic:

1. First deallocate call starts cooldown (`cooldownAssets`/`cooldownShares`) and returns `0`.
2. Later call after maturity executes `unstake`, transfers USDe to vault, returns received amount.

Additional requirements:

- track pending cooldown claims,
- include pending claim value in `strategyExposure(USDe)` to avoid false zero exposure,
- handle repeated deallocate requests while cooldown is pending.

Tradeoff:

- significantly more logic and more testing,
- emergency unwind semantics become weaker under active cooldown.

## Key Considerations Checklist

1. Liquidity timing risk:

- Cooldown-on means USDe cannot always be returned in the same transaction.
- This changes assumptions for allocator operations and incident response.

2. Accounting correctness:

- Pending cooldown claims must be represented in exposure accounting.
- Otherwise strategy removal and availability decisions can treat real exposure as zero.

3. Emergency behavior:

- `emergencySendToL2` tries to unwind positions, but cooldown-on can delay liquidity and reduce how effective that is.

4. Operational dependency:

- Ethena admin can change `cooldownDuration`; this is external governance risk.
- Add monitoring/alerts for cooldown changes.

5. Access restrictions:

- Restriction/blacklist role behavior in staking contracts must be operationally validated for adapter/vault addresses.

6. Reporting stance:

- Continue per-token reporting and keep reward tokens out of scope.
- Residual USDe dust should be reported when non-zero so `tokenTotals` stays easier to reason about.
- Tracked TVL-token discovery should include `USDe` plus any tokens the adapter declares in `tvlTokens(USDe)`.
- Breakdown output should stay predictable and easy to inspect.

## Potential Direction of Change

### Direction A (recommended now): Keep current vault interface and enforce cooldown-off

- Implement `EthenaSUSDeStrategy` with runtime guard: revert if `cooldownDuration != 0` on allocate/deallocate paths.
- Keep strategy fully synchronous with existing vault deallocation/unwind model.
- Add operational monitor: alert immediately on cooldown change away from zero.
- This is the lowest-risk path for delivery within a 3-week horizon.

### Direction B (future): Add explicit async-withdraw semantics

- Introduce request/claim lifecycle APIs (or equivalent adapter contract state machine with explicit pending state).
- Extend runbooks/tests for delayed liquidity, pending claims, and emergency path behavior.
- Use only if business requirements mandate cooldown-on compatibility.

### Direction C (intermediate): Adapter-only async shim without vault API changes

- Keep vault APIs unchanged, but adapter handles cooldown start/claim and may return `0` on early deallocate calls.
- Feasible but operationally fragile because it hides delayed behavior behind an interface that looks synchronous.
- Prefer only as temporary bridge, not final design.

## Effort Estimate

### Option A (cooldown-off only)

- New `EthenaSUSDeStrategy` adapter + interfaces: 2-3 days
- Unit tests (success/revert/edge) + mainnet-fork smoke tests: 2-3 days
- Vault integration runbook + deployment config/docs: 1 day
- Total: **~1 to 1.5 weeks**

### Option B (cooldown-on async)

- Async state machine + pending-claim accounting: 4-6 days
- Extra edge-case testing (cooldown windows, repeated requests, emergency behavior): 3-4 days
- Ops controls and runbook hardening: 2 days
- Total: **~2 to 3 weeks** (before external audit buffer)

## Recommended Implementation Order

1. Build Option A adapter with explicit `cooldownDuration == 0` guardrails.
2. Integrate and test with vault whitelisting/allocation/deallocation/reporting flows.
3. Add Option B only if operations require cooldown-on compatibility.
