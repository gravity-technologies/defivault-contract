# Morpho Integration Path

## Suitability

The current vault/strategy interfaces are suitable for Morpho integration.

Why this fits:

- Vault strategy interface is protocol-agnostic and ERC20-based (`contracts/interfaces/IYieldStrategy.sol`).
- Reporting is exact-token and separated from exposure scalar:
  - `assets(token) -> StrategyAssetBreakdown`
  - `principalBearingExposure(token) -> uint256`
- Vault tracked-token discovery is principal-token-only; non-principal receipt tokens are still queryable through exact-token reporting APIs.
- Strategy token domain is canonical ERC20 only (`address(0)` is not a strategy token key).

## Recommended Adapter Shapes

Use one adapter per principal/principal token domain (for example `USDC`).

### Option A: Morpho Vault (ERC4626 share token)

- Receipt token: vault share token (one non-principal token).
- `assets(principalToken)`:
  - include share token component as `InvestedPrincipal` (exact share units),
  - include principal-token residual as `ResidualUnderlying` when non-zero.
- `assets(shareToken)`:
  - return share-token component for exact-token queries.
- `principalBearingExposure(principalToken)`:
  - return principal-token-domain scalar using share conversion (`convertToAssets` style) plus residual principal token when applicable.

### Option B: Morpho Blue direct position

- No ERC20 receipt token expected for position accounting.
- `assets(principalToken)`:
  - report principal-token-domain component(s) only.
- `principalBearingExposure(principalToken)`:
  - return principal-token-domain exposure scalar from protocol accounting.

## Interface Contract Requirements

The adapter should satisfy all of the following:

- Unsupported token queries:
  - `assets(token)` returns empty components.
  - `principalBearingExposure(token)` returns `0` and does not revert.
- Canonical token boundary:
  - strategy APIs (`assets`, `principalBearingExposure`, `allocate`, `deallocate`, `deallocateAll`) use canonical ERC20 principal token keys.
  - native sentinel `address(0)` is not valid for strategy token inputs.
- `allocate(token, amount)`:
  - only vault caller,
  - pull principal token from vault (`transferFrom`),
  - deposit/supply to Morpho path.
- `deallocate(token, amount)` and `deallocateAll(token)`:
  - return principal token to vault,
  - return actual received amount.
- Keep reward/incentive tokens out of current reporting and exposure scalar.

## Vault Integration Steps

1. Deploy Morpho adapter with immutable config:
   - vault address,
   - principal/principal token,
   - Morpho protocol contract(s),
   - optional share token (ERC4626 path).
2. In vault admin flow:
   - `setPrincipalTokenConfig(principalToken, {supported: true})`,
   - `whitelistStrategy(principalToken, adapter, {whitelisted: true, cap})`.
3. Grant allocator role and run a smoke flow:
   - `allocatePrincipalToStrategy(principalToken, adapter, amount)`,
   - `deallocatePrincipalFromStrategy(principalToken, adapter, smallAmount)`.
4. Validate reporting surfaces:
   - `strategyAssets(principalToken, adapter)`,
   - `totalExactAssets(principalToken)`,
   - if share token exists, `totalExactAssets(shareToken)`,
   - `getTrackedPrincipalTokens()` continues to include only principal tokens.

## Critical Notes

- The vault is strict on malformed strategy reads for `totalExactAssets(token)`; keep adapter reads stable and non-reverting for supported query tokens.
- Tracked principal-token sync is write-time; if adapter component shape changes unexpectedly without write hooks, root registry updates on the next write hook execution.
- Tracked principal-token sync is write-time; if adapter component shape changes unexpectedly without write hooks, root registry updates on the next write hook execution.
- If strategy `assets(tokenDomain)` read fails during sync, root tracking can remain conservatively pinned until a later successful write hook or explicit override.
