// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IAaveGsm
 * @notice Minimal upstream-derived GSM interface used by the GHO strategy adapter.
 * @dev This follows the `IGsm` buy/sell and quote surface from `gho-origin` rather than a
 *      strategy-specific wrapper API.
 *      Source:
 *      https://github.com/aave-dao/gho-origin/blob/35ffdec21752d16f7688feea48bcbe470f66208f/src/contracts/facilitators/gsm/interfaces/IGsm.sol
 */
interface IAaveGsm {
    /**
     * @notice Returns the GHO token used by the GSM.
     */
    function GHO_TOKEN() external view returns (address);

    /**
     * @notice Returns the underlying asset accepted by the GSM.
     */
    function UNDERLYING_ASSET() external view returns (address);

    /**
     * @notice Returns the fee-strategy contract used by the GSM.
     */
    function getFeeStrategy() external view returns (address);

    /**
     * @notice Returns the price-strategy contract used by the GSM.
     */
    function PRICE_STRATEGY() external view returns (address);

    /**
     * @notice Sells the GSM underlying asset in exchange for buying GHO.
     * @param maxAmount Maximum amount of underlying asset to sell.
     * @param receiver Recipient of bought GHO.
     * @return assetSold Exact amount of underlying sold.
     * @return ghoBought Exact amount of GHO bought.
     */
    function sellAsset(uint256 maxAmount, address receiver) external returns (uint256 assetSold, uint256 ghoBought);

    /**
     * @notice Buys the GSM underlying asset in exchange for selling GHO.
     * @param minAmount Minimum amount of underlying asset to buy.
     * @param receiver Recipient of bought underlying asset.
     * @return assetBought Exact amount of underlying bought.
     * @return ghoSold Exact amount of GHO sold.
     */
    function buyAsset(uint256 minAmount, address receiver) external returns (uint256 assetBought, uint256 ghoSold);

    /**
     * @notice Quotes the result of selling up to `maxAssetAmount` of the underlying asset.
     * @param maxAssetAmount Maximum underlying asset amount to sell.
     * @return assetSold Exact amount of underlying sold.
     * @return ghoBought Exact amount of GHO bought.
     * @return grossGho Gross GHO amount before fee adjustment.
     * @return fee Fee charged by the GSM in GHO units.
     */
    function getGhoAmountForSellAsset(
        uint256 maxAssetAmount
    ) external view returns (uint256 assetSold, uint256 ghoBought, uint256 grossGho, uint256 fee);

    /**
     * @notice Quotes the GHO needed to buy at least `minAssetAmount` of the underlying asset.
     * @param minAssetAmount Minimum underlying asset amount desired.
     * @return assetBought Exact amount of underlying asset bought.
     * @return ghoSold Exact amount of GHO sold.
     * @return grossGho Gross GHO amount before fee adjustment.
     * @return fee Fee charged by the GSM in GHO units.
     */
    function getGhoAmountForBuyAsset(
        uint256 minAssetAmount
    ) external view returns (uint256 assetBought, uint256 ghoSold, uint256 grossGho, uint256 fee);

    /**
     * @notice Quotes the underlying asset output for spending up to `maxGhoAmount` of GHO.
     * @param maxGhoAmount Maximum GHO amount to spend.
     * @return assetBought Exact amount of underlying asset bought.
     * @return ghoSold Exact amount of GHO sold.
     * @return grossGho Gross GHO amount before fee adjustment.
     * @return fee Fee charged by the GSM in GHO units.
     */
    function getAssetAmountForBuyAsset(
        uint256 maxGhoAmount
    ) external view returns (uint256 assetBought, uint256 ghoSold, uint256 grossGho, uint256 fee);

    /**
     * @notice Quotes the underlying asset that must be sold to receive at least `minGhoAmount` GHO.
     * @param minGhoAmount Minimum GHO amount desired.
     * @return assetSold Exact amount of underlying asset sold.
     * @return ghoBought Exact amount of GHO bought.
     * @return grossGho Gross GHO amount before fee adjustment.
     * @return fee Fee charged by the GSM in GHO units.
     */
    function getAssetAmountForSellAsset(
        uint256 minGhoAmount
    ) external view returns (uint256 assetSold, uint256 ghoBought, uint256 grossGho, uint256 fee);
}
