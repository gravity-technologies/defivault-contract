# Compound Integration Path

## Suitability

The current vault/strategy interfaces are suitable for Compound integration, including Compound III (Comet) and Compound II style adapters.

Why this fits:
- Adapter API is token-domain based and does not assume a specific receipt mechanism (`contracts/interfaces/IYieldStrategy.sol`).
- Cap/exposure logic uses strategy scalar (`principalBearingExposure`) independent of reporting structure.
- Tracked-token registry supports zero or one non-root receipt token per `(tokenDomain, strategy)` in normal operation (`contracts/vault/GRVTDeFiVault.sol`).
- Strategy token domain is canonical ERC20 only (`address(0)` is not a strategy token key).

## Option A: Compound III (Comet, index-based)
- Typical shape: no receipt ERC20 token for supply position.
- `assets(baseToken)`:
  - report base-token exact units only (invested + residual as applicable).
- `principalBearingExposure(baseToken)`:
  - return principal-token exposure scalar from Comet accounting.
- `assets(otherToken)` and `principalBearingExposure(otherToken)`:
  - return empty / zero.

## Option B: Compound II (cToken)
- Typical shape: one non-root receipt token (`cToken`) plus optional underlying residual.
- `assets(principalToken)`:
  - include `cToken` invested component (exact `cToken` units),
  - include principal-token residual when present.
- `assets(cToken)`:
  - include `cToken` component for exact-token query support.
- `principalBearingExposure(principalToken)`:
  - return principal-token-domain scalar using current exchange-rate conversion plus residual principal token.

## Interface Contract Requirements

Adapter must satisfy:
- Unsupported queries:
  - `assets(token)` => empty components.
  - `principalBearingExposure(token)` => `0` (no unsupported-token revert).
- Canonical token boundary:
  - strategy APIs (`assets`, `principalBearingExposure`, `allocate`, `deallocate`, `deallocateAll`) use canonical ERC20 principal token keys.
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
   - `setTokenConfig(tokenDomain, {supported: true})`,
   - `whitelistStrategy(tokenDomain, adapter, {whitelisted: true, cap})`.
3. Run smoke lifecycle:
   - `allocateToStrategy(tokenDomain, adapter, amount)`,
   - `deallocateFromStrategy(tokenDomain, adapter, partialAmount)`,
   - `deallocateAllFromStrategy(tokenDomain, adapter)`.
4. Validate reporting:
   - `strategyAssets(tokenDomain, adapter)`,
   - `totalAssets(tokenDomain)`,
   - if receipt token exists, `totalAssets(receiptToken)`,
   - `getTrackedTokens()` behavior after allocate/deallocate hooks.

## Critical Notes

- `totalAssets(token)` is strict exact-token; adapter read errors for active strategies can cause revert on that strict path.
- Keep adapter math deterministic and bounded for index/exchange-rate conversions.
- Tracked-token sync is write-time. If strategy `assets(tokenDomain)` read fails during sync, vault preserves prior non-root registration.
- Under simplified tracked-token model, if adapter reports multiple distinct non-root tokens in one domain, vault emits `StrategyPositionTokenShapeUnsupported` and uses the first non-root token for registry sync.
