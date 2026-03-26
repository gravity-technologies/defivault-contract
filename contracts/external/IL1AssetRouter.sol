// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IL1AssetRouter
 * @notice Minimal zkSync L1 asset-router view surface needed by the native bridge gateway.
 */
interface IL1AssetRouter {
    /**
     * @notice Returns the native token vault used by the current asset-router stack.
     */
    function nativeTokenVault() external view returns (address);
}
