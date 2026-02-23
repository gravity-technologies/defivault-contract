// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Classifies how a strategy component contributes to token reporting.
enum TokenAmountComponentKind {
    InvestedPrincipal,
    ResidualUnderlying
}

/// @notice Exact-token component returned by strategy reporting.
/// @dev `amount` is denominated in `token` native units. No cross-token conversion is implied.
struct TokenAmountComponent {
    /// @notice Component token address.
    address token;
    /// @notice Component amount in `token` native units.
    uint256 amount;
    /// @notice Component classification.
    TokenAmountComponentKind kind;
}

/// @notice Structured strategy reporting surface.
/// @dev Unsupported token queries must return `components.length == 0`.
struct StrategyAssetBreakdown {
    TokenAmountComponent[] components;
}

/// @notice Strict exact-token totals for `totalAssets(token)`.
struct VaultTokenTotals {
    /// @notice Idle balance held directly by vault.
    uint256 idle;
    /// @notice Aggregate strategy balance for matching token components.
    uint256 strategy;
    /// @notice Sum of `idle + strategy`.
    uint256 total;
}

/// @notice Degraded exact-token totals that include strategy skip accounting.
struct VaultTokenStatus {
    /// @notice Idle balance held directly by vault.
    uint256 idle;
    /// @notice Aggregate strategy balance from valid strategy reads.
    uint256 strategy;
    /// @notice Sum of `idle + strategy`.
    uint256 total;
    /// @notice Number of strategies skipped due to invalid read behavior.
    uint256 skippedStrategies;
}
