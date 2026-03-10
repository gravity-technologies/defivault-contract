# Compound Integration Path

## Suitability

The current vault/strategy interfaces are suitable for Compound integration, including Compound III (Comet) and Compound II style adapters.

Why this fits:

- Adapter API is token-domain based and does not assume a specific receipt mechanism (`contracts/interfaces/IYieldStrategy.sol`).
- Cap/exposure logic uses strategy scalar (`principalBearingExposure`) independent of reporting structure.
- Tracked-token registry is principal-token-only for discovery (`getTrackedPrincipalTokens`/`isTrackedPrincipalToken`).
- Receipt-token exact totals remain available through `totalExactAssets(receiptToken)` via global active-strategy scans.
- Strategy token domain is canonical ERC20 only (`address(0)` is not a strategy token key).

## Option A: Compound III (Comet, index-based)

- Typical shape: no receipt ERC20 token for supply position.
- `exactTokenBalance(baseToken)`:
  - report base-token exact units only (invested + residual as applicable).
- `positionBreakdown(baseToken)`:
  - optionally report base-token principal-domain breakdown.
- `principalBearingExposure(baseToken)`:
  - return principal-token exposure scalar from Comet accounting.
- `exactTokenBalance(otherToken)`, `positionBreakdown(otherToken)`, and `principalBearingExposure(otherToken)`:
  - return `0` / empty / zero.

## Option B: Compound II (cToken)

- Typical shape: one non-principal receipt token (`cToken`) plus optional underlying residual.
- `positionBreakdown(principalToken)`:
  - include `cToken` invested component (exact `cToken` units),
  - include principal-token residual when present.
- `exactTokenBalance(cToken)`:
  - report `cToken` balance for exact-token query support.
- `principalBearingExposure(principalToken)`:
  - return principal-token-domain scalar using current exchange-rate conversion plus residual principal token.

## Interface Contract Requirements

Adapter must satisfy:

- Unsupported queries:
  - `exactTokenBalance(token)` => `0`.
  - `positionBreakdown(token)` => empty components.
  - `principalBearingExposure(token)` => `0` (no unsupported-token revert).
- Canonical token boundary:
  - strategy APIs (`exactTokenBalance`, `positionBreakdown`, `principalBearingExposure`, `allocate`, `deallocate`, `deallocateAll`) use canonical ERC20 principal token keys.
  - native sentinel `address(0)` is not valid for strategy token inputs.
- `allocate(token, amount)`:
  - vault-only caller,
  - pull principal token from vault,
  - supply/deposit to Compound market.
- `deallocate(token, amount)` / `deallocateAll(token)`:
  - withdraw/redeem from Compound,
  - transfer principal token back to vault,
  - return actual received amount.
- Exclude reward tokens (for example `COMP`) from current component reporting and exposure scalar.

## Vault Integration Steps

1. Deploy Compound adapter with immutable config:
   - vault address,
   - principal token domain (for example base token),
   - protocol addresses (Comet or cToken/Comptroller path),
   - optional receipt token address (`cToken`) for Compound II model.
2. Configure vault:
   - `setPrincipalTokenConfig(tokenDomain, {supported: true})`,
   - `setPrincipalStrategyWhitelist(tokenDomain, adapter, {whitelisted: true, cap, active: false})`.
3. Run smoke lifecycle:
   - `allocatePrincipalToStrategy(tokenDomain, adapter, amount)`,
   - `deallocatePrincipalFromStrategy(tokenDomain, adapter, partialAmount)`,
   - `deallocateAllPrincipalFromStrategy(tokenDomain, adapter)`.
4. Validate reporting:
   - `strategyPositionBreakdown(tokenDomain, adapter)`,
   - `totalExactAssets(tokenDomain)`,
   - if receipt token exists, `totalExactAssets(receiptToken)`,
   - `getTrackedPrincipalTokens()` remains principal-token-only after allocate/deallocate hooks.

## Critical Notes

- `totalExactAssets(token)` is strict exact-token; adapter read errors for active strategies can cause revert on that strict path.
- Keep adapter math deterministic and bounded for index/exchange-rate conversions.
- Tracked-principal discovery intentionally ignores non-principal receipt-token shape.
- Root tracking sync is write-time; if strategy reads fail during sync, tracking can stay conservatively pinned until the next successful write hook or explicit override.
