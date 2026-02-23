// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * Strategy interface (AaveV3Strategy, CompoundStrategy, etc.)
 * Vault centralizes protocol communication through these strategies.
 */
interface IYieldStrategy {
    function name() external view returns (string memory);

    /// Returns amount of `token` (underlying) currently attributable to the vault in this strategy.
    function assets(address token) external view returns (uint256);

    /// Deposit `amount` of underlying `token` from vault into protocol.
    function allocate(address token, uint256 amount) external;

    /// Withdraw `amount` of underlying `token` back to vault. Returns actual received.
    function deallocate(address token, uint256 amount) external returns (uint256 received);

    /// Withdraw maximum possible back to vault. Returns actual received.
    function deallocateAll(address token) external returns (uint256 received);
}
