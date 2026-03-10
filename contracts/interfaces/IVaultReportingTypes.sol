// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Describes how a reported token balance should be interpreted.
enum PositionComponentKind {
    /// @notice Token representing funds actively deployed in a protocol.
    /// @dev Examples: `aUSDT` on Aave, `cUSDC` on Compound v2, ERC4626 shares, LP shares.
    InvestedPosition,
    /// @notice Token balance held alongside the invested position.
    /// @dev Examples: residual `USDT` after an Aave supply, or unstaked underlying held between actions.
    UninvestedToken
}

/// @notice Token balance returned by strategy reporting.
/// @dev `amount` stays in `token` units. No conversion between token types is implied.
struct PositionComponent {
    /// @notice Component token address.
    address token;
    /// @notice Component amount in `token` native units.
    uint256 amount;
    /// @notice Component classification.
    PositionComponentKind kind;
}

/// @notice Balances returned by `tokenTotals(token)`.
/// @dev TVL trackers should use `total` as the reported value. `idle` and `strategy`
///      are provided as a diagnostic breakdown.
struct TokenTotals {
    /// @notice Diagnostic: balance of the token held directly by the vault.
    uint256 idle;
    /// @notice Diagnostic: balance of the token reported by all strategies combined.
    uint256 strategy;
    /// @notice Primary reporting value: total token balance across the vault and all strategies.
    uint256 total;
}

/// @notice Balances returned by `tokenTotalsConservative(token)`, plus how many strategies were skipped.
/// @dev TVL trackers should use `total` as the reported value. `idle`, `strategy`, and
///      `skippedStrategies` are provided for diagnostics and degraded-read handling.
struct ConservativeTokenTotals {
    /// @notice Diagnostic: balance of the token held directly by the vault.
    uint256 idle;
    /// @notice Diagnostic: balance of the token reported by strategies whose reads succeeded.
    uint256 strategy;
    /// @notice Primary reporting value: total token balance from the vault plus successful strategy reads.
    uint256 total;
    /// @notice Number of strategies skipped due to invalid read behavior.
    uint256 skippedStrategies;
}
