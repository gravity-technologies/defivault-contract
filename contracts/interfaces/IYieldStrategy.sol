// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {StrategyAssetBreakdown} from "./IVaultReportingTypes.sol";

/**
 * @title IYieldStrategy
 * @notice Protocol-agnostic strategy adapter interface used by the vault.
 * @dev Vault centralizes protocol communication through whitelisted adapters.
 *
 * Reporting model:
 * - `exactTokenBalance(token)` returns only the strategy-held amount for that exact token address.
 * - `positionBreakdown(principalToken)` returns the full principal-domain component shape for diagnostics.
 * - Unsupported token/breakdown queries must return `0` / empty components without reverting solely because
 *   the query is unsupported.
 * - Harvest/cap scalar is provided separately via `principalBearingExposure(token)`.
 * - Unsupported `principalBearingExposure(token)` queries must return 0 and must not revert.
 *
 * Protocol-agnostic adapter examples:
 * - Aave-style adapters can expose aToken and residual underlying via `positionBreakdown(underlying)`, while
 *   still reporting exact-token balances independently.
 * - Compound-style adapters can expose exact balances directly and optionally provide a principal-domain breakdown.
 * - Morpho/ERC4626-style adapters can expose share-token + residual components while exposing scalar assets.
 */
interface IYieldStrategy {
    /// @notice Human-readable strategy identifier.
    function name() external view returns (string memory);

    /// @notice Returns the strategy-held balance for one exact token address.
    /// @dev Must not perform denomination conversion. Unsupported token queries return `0`.
    function exactTokenBalance(address token) external view returns (uint256);

    /**
     * @notice Returns the full principal-domain breakdown attributable to the vault.
     * @param principalToken Canonical principal token-domain query key.
     * @return breakdown Structured principal-domain component breakdown.
     *
     * @dev Requirements:
     * - Component amounts are denominated in each component token's native units.
     * - Implementations must not convert one token amount into another token denomination.
     * - Unsupported principal-token queries return `components.length == 0`.
     */
    function positionBreakdown(address principalToken) external view returns (StrategyAssetBreakdown memory);

    /**
     * @notice Returns principal-bearing exposure in the queried token domain.
     * @param token Canonical token-domain query key.
     * @return exposure Principal-bearing exposure scalar in the queried token domain.
     *
     * @dev This scalar is used by vault harvest/cap logic and is intentionally independent from
     * exact-token reporting and principal-domain breakdowns.
     * Unsupported token queries must return `0` and must not revert solely due to token unsupported status.
     */
    function principalBearingExposure(address token) external view returns (uint256);

    /// @notice Deposits principal token from vault into the strategy/protocol.
    /// @param token Canonical principal token key.
    /// @param amount Amount to allocate.
    function allocate(address token, uint256 amount) external;

    /// @notice Withdraws principal token from strategy back to vault.
    /// @param token Canonical principal token key.
    /// @param amount Requested amount to deallocate.
    /// @return received Actual amount received by vault.
    function deallocate(address token, uint256 amount) external returns (uint256 received);

    /// @notice Withdraws maximum available principal token amount from strategy back to vault.
    /// @param token Canonical principal token key.
    /// @return received Actual amount received by vault.
    function deallocateAll(address token) external returns (uint256 received);
}
