// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PositionComponent} from "./IVaultReportingTypes.sol";

/**
 * @title IYieldStrategy
 * @notice Strategy interface the vault uses to interact with external protocols.
 * @dev The vault talks to each protocol through a whitelisted strategy contract.
 *
 * Reporting rules:
 * - `exactTokenBalance(token)` returns only the balance for that token address.
 * - `positionBreakdown(vaultToken)` returns the full list of tokens and amounts for that vault token.
 * - Unsupported queries must return `0` or an empty array instead of reverting just because the token is unsupported.
 * - `strategyExposure(vaultToken)` returns the single number the vault uses for caps and harvests.
 * - `tvlTokens(vaultToken)` returns the ERC20 tokens this strategy can report for TVL under that vault token.
 *
 * Example implementations:
 * - An Aave strategy can report aToken and leftover underlying separately.
 * - A Compound strategy can report direct balances and optionally a simple breakdown.
 * - A Morpho or ERC4626 strategy can report share tokens plus leftover underlying while still returning one exposure value.
 */
interface IYieldStrategy {
    /// @notice Human-readable strategy identifier.
    function name() external view returns (string memory);

    /// @notice Returns the strategy-held balance for one token address.
    /// @dev Must not convert between token types. Unsupported token queries return `0`.
    function exactTokenBalance(address token) external view returns (uint256);

    /**
     * @notice Returns the ERC20 tokens this strategy may report for `vaultToken` in TVL.
     * @dev Unsupported vault-token queries return an empty array. Output must be deterministic,
     * contain no zero addresses, and contain no duplicates.
     */
    function tvlTokens(address vaultToken) external view returns (address[] memory);

    /**
     * @notice Returns the tokens and amounts this strategy currently reports for `vaultToken`.
     * @param vaultToken Vault token being queried.
     * @return components Reported token balances for `vaultToken`.
     *
     * @dev Requirements:
     * - Each amount stays in that token's own units.
     * - Implementations must not convert one token amount into another token type.
     * - Unsupported vault-token queries return `components.length == 0`.
     */
    function positionBreakdown(address vaultToken) external view returns (PositionComponent[] memory);

    /**
     * @notice Returns the exposure number the vault uses for the queried vault token.
     * @param vaultToken Vault token being queried.
     * @return exposure Strategy exposure for `vaultToken`.
     *
     * @dev This value is used by vault cap and harvest logic and is separate from token-by-token reporting.
     * Unsupported vault-token queries must return `0` and must not revert just because the token is unsupported.
     */
    function strategyExposure(address vaultToken) external view returns (uint256);

    /// @notice Deposits a vault token from the vault into the strategy or external protocol.
    /// @param vaultToken Vault token to deposit.
    /// @param amount Amount to allocate.
    function allocate(address vaultToken, uint256 amount) external;

    /// @notice Withdraws a vault token from the strategy back to the vault.
    /// @param vaultToken Vault token to withdraw.
    /// @param amount Requested amount to deallocate.
    /// @return received Actual amount received by vault from the strategy path.
    function deallocate(address vaultToken, uint256 amount) external returns (uint256 received);

    /// @notice Withdraws the maximum available vault token amount from the strategy back to the vault.
    /// @param vaultToken Vault token to withdraw.
    /// @return received Actual amount received by vault from the strategy path.
    function deallocateAll(address vaultToken) external returns (uint256 received);
}
