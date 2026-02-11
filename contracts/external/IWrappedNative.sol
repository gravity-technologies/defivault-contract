// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IWrappedNative
 * @notice Minimal wrapped-native interface consumed by vault bridge and ingress flows.
 */
interface IWrappedNative {
    /// @notice Wraps native ETH into wrapped-native token.
    function deposit() external payable;

    /// @notice Unwraps wrapped-native token into native ETH.
    /// @param amount Wrapped-native amount to unwrap.
    function withdraw(uint256 amount) external;
}
