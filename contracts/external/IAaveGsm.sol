// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IAaveGsm
 * @notice Minimal GSM interface for vault-token <-> GHO swaps used by the GHO strategy adapter.
 */
interface IAaveGsm {
    /**
     * @notice Quotes the GHO output for swapping `assetAmount` of `asset` into GHO.
     * @param asset Input asset being sold to GSM.
     * @param assetAmount Amount of `asset` provided.
     * @return ghoOut Previewed GHO output before execution.
     */
    function previewSwapAssetToGho(address asset, uint256 assetAmount) external view returns (uint256 ghoOut);

    /**
     * @notice Swaps `assetAmount` of `asset` into GHO.
     * @param asset Input asset being sold to GSM.
     * @param assetAmount Amount of `asset` provided.
     * @param minGhoOut Minimum acceptable GHO output.
     * @param recipient Recipient of minted/transferred GHO.
     * @return ghoOut Actual GHO output.
     */
    function swapAssetToGho(
        address asset,
        uint256 assetAmount,
        uint256 minGhoOut,
        address recipient
    ) external returns (uint256 ghoOut);

    /**
     * @notice Quotes the net asset output and explicit fee for swapping GHO back into `asset`.
     * @param asset Output asset requested.
     * @param ghoAmount Gross GHO input amount.
     * @return assetOut Net `asset` output after fee.
     * @return fee Explicit fee charged in `asset` units.
     */
    function previewSwapGhoToAsset(
        address asset,
        uint256 ghoAmount
    ) external view returns (uint256 assetOut, uint256 fee);

    /**
     * @notice Quotes the gross GHO input required to receive an exact `assetAmountOut`.
     * @param asset Output asset requested.
     * @param assetAmountOut Exact net asset amount desired.
     * @return ghoIn Gross GHO input required.
     * @return fee Explicit fee charged in `asset` units.
     */
    function previewExactAssetOutFromGho(
        address asset,
        uint256 assetAmountOut
    ) external view returns (uint256 ghoIn, uint256 fee);

    /**
     * @notice Swaps gross GHO into `asset`.
     * @param asset Output asset requested.
     * @param ghoAmount Gross GHO input amount.
     * @param minAssetOut Minimum acceptable net `asset` output.
     * @param recipient Recipient of output asset.
     * @return assetOut Net `asset` output after fee.
     * @return fee Explicit fee charged in `asset` units.
     */
    function swapGhoToAsset(
        address asset,
        uint256 ghoAmount,
        uint256 minAssetOut,
        address recipient
    ) external returns (uint256 assetOut, uint256 fee);
}
