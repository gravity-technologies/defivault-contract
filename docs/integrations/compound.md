# Compound Integration Path

## Suitability

The current vault/strategy interfaces are suitable for Compound integration, including Compound III (Comet) and Compound II style adapters.

Why this fits:

- Adapter API is vault-token based and does not assume a specific receipt-token model (`contracts/interfaces/IYieldStrategy.sol`).
- Cap and harvest logic use `strategyExposure` separately from per-token reporting.
- Tracked TVL-token discovery follows the adapter's declared token list: `getTrackedTvlTokens()` can include both the vault token and any declared receipt or share tokens.
- Receipt-token exact totals remain available through `tokenTotals(receiptToken)` via global active-strategy scans.
- Strategy token input is ERC20-only (`address(0)` is not a strategy token key).

## Option A: Compound III (Comet, index-based)

- Typical shape: no receipt ERC20 token for supply position.
- `exactTokenBalance(baseToken)`:
  - report base-token exact units only (invested + residual as applicable).
- `positionBreakdown(baseToken)`:
  - optionally report base-token position breakdown.
- `strategyExposure(baseToken)`:
  - return the vault-token exposure value from Comet accounting.
- `exactTokenBalance(otherToken)`, `positionBreakdown(otherToken)`, and `strategyExposure(otherToken)`:
  - return `0` / empty / zero.

## Option B: Compound II (cToken)

- Typical shape: one receipt token (`cToken`) plus optional underlying residual.
- `positionBreakdown(vaultToken)`:
  - include `cToken` invested component (exact `cToken` units),
  - include vault-token residual when present.
- `exactTokenBalance(cToken)`:
  - report `cToken` balance for exact-token query support.
- `strategyExposure(vaultToken)`:
  - return the vault-token exposure value using current exchange-rate conversion plus residual vault token.

## Interface Requirements

Adapter must satisfy:

- Unsupported queries:
  - `exactTokenBalance(token)` => `0`.
  - `positionBreakdown(token)` => empty components.
  - `strategyExposure(token)` => `0` (no unsupported-token revert).
- Vault-token rules:
  - strategy APIs (`exactTokenBalance`, `positionBreakdown`, `strategyExposure`, `allocate`, `deallocate`, `deallocateAll`) use ERC20 vault tokens.
  - native sentinel `address(0)` is not valid for strategy token inputs.
- `allocate(token, amount)`:
  - vault-only caller,
  - pull vault token from vault,
  - supply/deposit to Compound market.
- `deallocate(token, amount)` / `deallocateAll(token)`:
  - withdraw/redeem from Compound,
  - transfer vault token back to vault,
  - return actual received amount.
- Exclude reward tokens such as `COMP` from current reporting and from the exposure value.

## Vault Integration Steps

1. Deploy Compound adapter with immutable config:
   - vault address,
   - vault token (for example base token),
   - protocol addresses (Comet or cToken/Comptroller path),
   - optional receipt token address (`cToken`) for Compound II model.
2. Configure vault:
   - `setVaultTokenConfig(tokenDomain, {supported: true})`,
   - `setVaultTokenStrategyConfig(tokenDomain, adapter, {whitelisted: true, cap, active: false})`.
3. Run a smoke flow:
   - `allocateVaultTokenToStrategy(tokenDomain, adapter, amount)`,
   - `deallocateVaultTokenFromStrategy(tokenDomain, adapter, partialAmount)`,
   - `deallocateAllVaultTokenFromStrategy(tokenDomain, adapter)`.
4. Validate reporting:
   - `strategyPositionBreakdown(tokenDomain, adapter)`,
   - `tokenTotals(tokenDomain)`,
   - if receipt token exists, `tokenTotals(receiptToken)`,
   - `getTrackedTvlTokens()` / `trackedTvlTokenTotals()` include the vault token plus any tokens declared in `tvlTokens(vaultToken)`.

## Critical Notes

- `tokenTotals(token)` reverts when an active strategy read fails.
- Keep adapter math deterministic and bounded for index/exchange-rate conversions.
- TVL-token discovery follows cached `tvlTokens(vaultToken)` lists, not live `positionBreakdown` reads.
- Tracked TVL-token sync happens on write paths; if token-list reads fail during sync, tracking can stay in place until the next successful write call, explicit refresh, or override.
