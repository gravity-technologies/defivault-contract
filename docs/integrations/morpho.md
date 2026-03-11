# Morpho Integration Path

## Suitability

The current vault/strategy interfaces are suitable for Morpho integration.

Why this fits:

- Vault strategy interface is protocol-agnostic and ERC20-based (`contracts/interfaces/IYieldStrategy.sol`).
- Reporting is exact-token and separated from exposure scalar:
  - `assets(token) -> StrategyAssetBreakdown`
  - `principalBearingExposure(token) -> uint256`
- Vault tracked-token discovery is root-token-only; non-root receipt tokens are still queryable through exact-token reporting APIs.

## Recommended Adapter Shapes

Use one adapter per underlying market domain token (for example `USDC`).

### Option A: Morpho Vault (ERC4626 share token)

- Receipt token: vault share token (one non-root token).
- `assets(underlying)`:
  - include share token component as `InvestedPrincipal` (exact share units),
  - include underlying residual as `ResidualUnderlying` when non-zero.
- `assets(shareToken)`:
  - return share-token component for exact-token queries.
- `principalBearingExposure(underlying)`:
  - return underlying-domain scalar using share conversion (`convertToAssets` style) plus residual underlying when applicable.

### Option B: Morpho Blue direct position

- No ERC20 receipt token expected for position accounting.
- `assets(underlying)`:
  - report underlying-domain component(s) only.
- `principalBearingExposure(underlying)`:
  - return underlying-domain exposure scalar from protocol accounting.

## Interface Contract Requirements

The adapter should satisfy all of the following:

- Unsupported token queries:
  - `assets(token)` returns empty components.
  - `principalBearingExposure(token)` returns `0` and does not revert.
- `allocate(token, amount)`:
  - only vault caller,
  - pull underlying from vault (`transferFrom`),
  - deposit/supply to Morpho path.
- `deallocate(token, amount)` and `deallocateAll(token)`:
  - return underlying to vault,
  - return actual received amount.
- Keep reward/incentive tokens out of V1 reporting and exposure scalar.

## Vault Integration Steps

1. Deploy Morpho adapter with immutable config:
   - vault address,
   - underlying token,
   - Morpho protocol contract(s),
   - optional share token (ERC4626 path).
2. In vault admin flow:
   - `setTokenConfig(underlying, {supported: true})`,
   - `whitelistStrategy(underlying, adapter, {whitelisted: true, cap})`.
3. Grant allocator role and run a smoke flow:
   - `allocateToStrategy(underlying, adapter, amount)`,
   - `deallocateFromStrategy(underlying, adapter, smallAmount)`.
4. Validate reporting surfaces:
   - `strategyAssets(underlying, adapter)`,
   - `totalAssets(underlying)`,
   - if share token exists, `totalAssets(shareToken)`,
   - `getTrackedTokens()` continues to include only root tokens.

## Critical Notes

- The vault is strict on malformed strategy reads for `totalAssets(token)`; keep adapter reads stable and non-reverting for supported query tokens.
- Tracked root-token sync is write-time; if adapter component shape changes unexpectedly without write hooks, root registry updates on the next write hook execution.
