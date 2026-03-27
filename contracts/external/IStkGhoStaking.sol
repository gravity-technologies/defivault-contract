// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IStkGhoStaking
 * @notice Minimal staking interface for GHO <-> stkGHO conversion.
 */
interface IStkGhoStaking {
    /**
     * @notice Converts `shares` into currently redeemable GHO assets.
     * @param shares Amount of stkGHO shares.
     * @return assets Amount of GHO assets currently represented by `shares`.
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /**
     * @notice Returns the number of shares that must be burned to withdraw `assets`.
     * @param assets Amount of GHO assets to withdraw.
     * @return shares Amount of stkGHO shares that must be burned.
     */
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);

    /**
     * @notice Stakes GHO and mints stkGHO shares.
     * @param assets Amount of GHO to stake.
     * @param receiver Recipient of stkGHO shares.
     * @return shares Amount of stkGHO minted.
     */
    function stake(uint256 assets, address receiver) external returns (uint256 shares);

    /**
     * @notice Burns stkGHO shares and returns GHO.
     * @param shares Amount of stkGHO to burn.
     * @param receiver Recipient of unstaked GHO.
     * @return assets Amount of GHO returned.
     */
    function unstake(uint256 shares, address receiver) external returns (uint256 assets);
}
