# Morpho Integration Path

## Suitability

The current vault/strategy interfaces are suitable for Morpho integration.

Why this fits:

- Vault strategy interface is protocol-agnostic and ERC20-based (`contracts/interfaces/IYieldStrategy.sol`).
- Reporting is per-token and kept separate from the exposure value:
  - `exactTokenBalance(token) -> uint256`
  - `positionBreakdown(vaultToken) -> PositionComponent[]`
  - `strategyExposure(token) -> uint256`
- Tracked TVL-token discovery is driven by the adapter's declared token list, so share tokens can appear in `getTrackedTvlTokens()` when the adapter declares them.
- Strategy token input is ERC20-only (`address(0)` is not a strategy token key).

## Recommended Adapter Designs

Use one adapter per vault token (for example `USDC`).

### Option A: Morpho Vault (ERC4626 share token)

- Receipt token: vault share token (one non-vault token).
- `positionBreakdown(vaultToken)`:
  - include share token component as `InvestedPosition` (exact share units),
  - include vault-token residual as `UninvestedToken` when non-zero.
- `exactTokenBalance(shareToken)`:
  - return share-token balance for exact-token queries.
- `strategyExposure(vaultToken)`:
  - return the vault-token exposure value using share conversion (`convertToAssets` style) plus residual vault token when applicable.

### Option B: Morpho Blue direct position

- No ERC20 receipt token is expected for position accounting.
- `exactTokenBalance(vaultToken)`:
  - report exact vault-token units.
- `positionBreakdown(vaultToken)`:
  - report vault-token component(s) only.
- `strategyExposure(vaultToken)`:
  - return the vault-token exposure value from protocol accounting.

## Interface Requirements

The adapter should satisfy all of the following:

- Unsupported token queries:
  - `exactTokenBalance(token)` returns `0`.
  - `positionBreakdown(token)` returns empty components.
  - `strategyExposure(token)` returns `0` and does not revert.
- Vault-token rules:
  - strategy APIs (`exactTokenBalance`, `positionBreakdown`, `strategyExposure`, `allocate`, `deallocate`, `deallocateAll`) use ERC20 vault tokens.
  - native sentinel `address(0)` is not valid for strategy token inputs.
- `allocate(token, amount)`:
  - only vault caller,
  - pull vault token from vault (`transferFrom`),
  - deposit/supply to Morpho path.
- `deallocate(token, amount)` and `deallocateAll(token)`:
  - return vault token to vault,
  - return actual received amount.
- Keep reward/incentive tokens out of current reporting and the exposure value.

## Vault Integration Steps

1. Deploy Morpho adapter with immutable config:
   - vault address,
   - vault token,
   - Morpho protocol contract(s),
   - optional share token (ERC4626 path).
2. In vault admin flow:
   - `setVaultTokenConfig(vaultToken, {supported: true})`,
   - `setVaultTokenStrategyConfig(vaultToken, adapter, {whitelisted: true, cap, active: false})`.
3. Grant allocator role and run a smoke flow:
   - `allocateVaultTokenToStrategy(vaultToken, adapter, amount)`,
   - `deallocateVaultTokenFromStrategy(vaultToken, adapter, smallAmount)`.
4. Validate reporting surfaces:
   - `strategyPositionBreakdown(vaultToken, adapter)`,
   - `tokenTotals(vaultToken)`,
   - if share token exists, `tokenTotals(shareToken)`,
   - `getTrackedTvlTokens()` / `trackedTvlTokenTotals()` include the vault token plus any share token declared in `tvlTokens(vaultToken)`.

## Critical Notes

- `tokenTotals(token)` reverts on malformed strategy reads, so keep adapter reads stable and non-reverting for supported query tokens.
- Tracked TVL-token sync happens on write paths; if the adapter changes which tokens it reports without a write hook, the registry updates on the next write call or explicit token-list refresh.
- If strategy token-balance reads fail, `tokenTotals` reverts and `tokenTotalsConservative` stays conservative until the adapter read path is healthy again.
