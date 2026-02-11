// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StrategyAssetBreakdown} from "./IVaultReportingTypes.sol";

/**
 * @title IYieldStrategy
 * @notice Protocol-agnostic strategy adapter interface used by the vault.
 * @dev Vault centralizes protocol communication through whitelisted adapters.
 *
 * Reporting model:
 * - `assets(token)` returns token-address exact components only.
 * - Unsupported token queries must return an empty component array.
 * - Harvest/cap scalar is provided separately via `principalBearingExposure(token)`.
 * - Unsupported `principalBearingExposure(token)` queries must return 0 and must not revert.
 *
 * Protocol-agnostic adapter examples:
 * - Aave-style adapters can report receipt + residual components and expose a scalar in underlying domain.
 * - Compound-style adapters can report index-model accounting in exact token units.
 * - Morpho/ERC4626-style adapters can report share-token + residual components while exposing scalar assets.
 */
interface IYieldStrategy {
    /// @notice Human-readable strategy identifier.
    function name() external view returns (string memory);

    /**
     * @notice Returns exact-token reporting components attributable to the vault.
     * @param token Canonical token-domain query key.
     * @return breakdown Token-address exact component breakdown for the queried token domain.
     *
     * @dev Requirements:
     * - Component amounts are denominated in each component token's native units.
     * - Implementations must not convert one token amount into another token denomination.
     * - Unsupported token queries return `components.length == 0`.
     */
    function assets(address token) external view returns (StrategyAssetBreakdown memory);

    /**
     * @notice Returns principal-bearing exposure in the queried token domain.
     * @param token Canonical token-domain query key.
     * @return exposure Principal-bearing exposure scalar in the queried token domain.
     *
     * @dev This scalar is used by vault harvest/cap logic and is intentionally independent from
     * exact-token reporting components returned by `assets(token)`.
     * Unsupported token queries must return `0` and must not revert solely due to token unsupported status.
     */
    function principalBearingExposure(address token) external view returns (uint256);

    /// @notice Deposits underlying token from vault into the strategy/protocol.
    /// @param token Canonical underlying token key.
    /// @param amount Amount to allocate.
    function allocate(address token, uint256 amount) external;

    /// @notice Withdraws underlying token from strategy back to vault.
    /// @param token Canonical underlying token key.
    /// @param amount Requested amount to deallocate.
    /// @return received Actual amount received by vault.
    function deallocate(address token, uint256 amount) external returns (uint256 received);

    /// @notice Withdraws maximum available amount from strategy back to vault.
    /// @param token Canonical underlying token key.
    /// @return received Actual amount received by vault.
    function deallocateAll(address token) external returns (uint256 received);
}
