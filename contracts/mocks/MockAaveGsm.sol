// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveGsm} from "../external/IAaveGsm.sol";

interface IMockMintableToken {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockAaveGsm
 * @notice Test-only GSM mock with configurable sell-side and buy-side execution fees.
 */
contract MockAaveGsm is IAaveGsm {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_SCALE = 10_000;

    error InvalidParam();

    address public immutable gho;
    address public immutable underlyingAsset;
    uint256 public burnFeeBps;
    uint256 public assetToGhoExecutionBps;
    uint256 public assetToGhoQuoteBps;
    uint256 public assetToGhoExecutionFillBps;
    uint256 public ghoToAssetExecutionBps;
    uint256 public ghoToAssetQuoteSpendBps;
    uint256 public assetToGhoScale;

    constructor(address gho_, address underlyingAsset_) {
        if (gho_ == address(0) || underlyingAsset_ == address(0)) revert InvalidParam();
        gho = gho_;
        underlyingAsset = underlyingAsset_;
    }

    function setBurnFeeBps(address asset, uint256 feeBps_) external {
        if (asset == address(0) || feeBps_ >= BPS_SCALE) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        burnFeeBps = feeBps_;
    }

    function setAssetToGhoExecutionBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        assetToGhoExecutionBps = bps;
    }

    function setAssetToGhoExecutionFillBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        assetToGhoExecutionFillBps = bps;
    }

    function setAssetToGhoQuoteBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        assetToGhoQuoteBps = bps;
    }

    function setGhoToAssetExecutionBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        ghoToAssetExecutionBps = bps;
    }

    function setGhoToAssetQuoteSpendBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        ghoToAssetQuoteSpendBps = bps;
    }

    function setAssetToGhoScale(address asset, uint256 scale_) external {
        if (asset == address(0) || scale_ == 0) revert InvalidParam();
        _requireUnderlyingAsset(asset);
        assetToGhoScale = scale_;
    }

    function GHO_TOKEN() external view returns (address) {
        return gho;
    }

    function UNDERLYING_ASSET() external view returns (address) {
        return underlyingAsset;
    }

    function sellAsset(uint256 maxAmount, address receiver) external returns (uint256 assetSold, uint256 ghoBought) {
        if (maxAmount == 0 || receiver == address(0)) revert InvalidParam();

        uint256 fillBps = _executionBpsOrDefault(assetToGhoExecutionFillBps);
        assetSold = (maxAmount * fillBps) / BPS_SCALE;
        if (assetSold == 0) revert InvalidParam();
        uint256 scale = _assetScaleOrDefault(assetToGhoScale);
        uint256 executionBps = _executionBpsOrDefault(assetToGhoExecutionBps);
        ghoBought = (assetSold * scale * executionBps) / BPS_SCALE;

        IERC20(underlyingAsset).safeTransferFrom(msg.sender, address(this), assetSold);
        IMockMintableToken(gho).mint(receiver, ghoBought);
    }

    function buyAsset(uint256 minAmount, address receiver) external returns (uint256 assetBought, uint256 ghoSold) {
        if (minAmount == 0 || receiver == address(0)) revert InvalidParam();

        uint256 maxGhoAmount = IERC20(gho).allowance(msg.sender, address(this));
        if (maxGhoAmount == 0) revert InvalidParam();

        (uint256 previewAssetBought, , , ) = this.getAssetAmountForBuyAsset(maxGhoAmount);
        uint256 executionBps = _executionBpsOrDefault(ghoToAssetExecutionBps);
        assetBought = (previewAssetBought * executionBps) / BPS_SCALE;
        if (assetBought < minAmount) revert InvalidParam();

        ghoSold = maxGhoAmount;
        IERC20(gho).safeTransferFrom(msg.sender, address(this), ghoSold);
        IMockMintableToken(underlyingAsset).mint(receiver, assetBought);
    }

    function getGhoAmountForSellAsset(
        uint256 maxAssetAmount
    ) external view returns (uint256 assetSold, uint256 ghoBought, uint256 grossGho, uint256 fee) {
        if (maxAssetAmount == 0) return (0, 0, 0, 0);
        uint256 scale = _assetScaleOrDefault(assetToGhoScale);
        uint256 quoteBps = _quoteBpsOrDefault(assetToGhoQuoteBps, assetToGhoExecutionBps);
        assetSold = maxAssetAmount;
        grossGho = assetSold * scale;
        ghoBought = (grossGho * quoteBps) / BPS_SCALE;
        fee = grossGho - ghoBought;
    }

    function getGhoAmountForBuyAsset(
        uint256 minAssetAmount
    ) external view returns (uint256 assetBought, uint256 ghoSold, uint256 grossGho, uint256 fee) {
        return _quoteGhoAmountForBuyAsset(minAssetAmount);
    }

    function getAssetAmountForBuyAsset(
        uint256 maxGhoAmount
    ) external view returns (uint256 assetBought, uint256 ghoSold, uint256 grossGho, uint256 fee) {
        if (maxGhoAmount == 0) return (0, 0, 0, 0);

        uint256 quoteSpendBps = _executionBpsOrDefault(ghoToAssetQuoteSpendBps);
        ghoSold = (maxGhoAmount * quoteSpendBps) / BPS_SCALE;
        if (ghoSold == 0) return (0, 0, 0, 0);
        uint256 scale = _assetScaleOrDefault(assetToGhoScale);
        uint256 grossAssetAmount = ghoSold / scale;
        uint256 feeAsset = (grossAssetAmount * burnFeeBps) / BPS_SCALE;
        assetBought = grossAssetAmount - feeAsset;
        grossGho = grossAssetAmount * scale;
        fee = feeAsset * scale;
    }

    function getAssetAmountForSellAsset(
        uint256 minGhoAmount
    ) external view returns (uint256 assetSold, uint256 ghoBought, uint256 grossGho, uint256 fee) {
        if (minGhoAmount == 0) return (0, 0, 0, 0);
        uint256 scale = _assetScaleOrDefault(assetToGhoScale);
        assetSold = (minGhoAmount + (scale - 1)) / scale;
        grossGho = assetSold * scale;
        ghoBought = grossGho;
        fee = 0;
    }

    function _executionBpsOrDefault(uint256 configuredBps) internal pure returns (uint256 executionBps) {
        return configuredBps == 0 ? BPS_SCALE : configuredBps;
    }

    function _quoteBpsOrDefault(
        uint256 configuredQuoteBps,
        uint256 configuredExecutionBps
    ) internal pure returns (uint256) {
        return configuredQuoteBps == 0 ? _executionBpsOrDefault(configuredExecutionBps) : configuredQuoteBps;
    }

    function _assetScaleOrDefault(uint256 configuredScale) internal pure returns (uint256 scale_) {
        return configuredScale == 0 ? 1 : configuredScale;
    }

    function _quoteGhoAmountForBuyAsset(
        uint256 minAssetAmount
    ) internal view returns (uint256 assetBought, uint256 ghoSold, uint256 grossGho, uint256 fee) {
        if (minAssetAmount == 0) return (0, 0, 0, 0);
        uint256 scale = _assetScaleOrDefault(assetToGhoScale);
        uint256 grossAssetAmount = (minAssetAmount * BPS_SCALE + (BPS_SCALE - burnFeeBps - 1)) /
            (BPS_SCALE - burnFeeBps);
        assetBought = minAssetAmount;
        grossGho = grossAssetAmount * scale;
        ghoSold = grossGho;
        fee = ghoSold - grossGho;
    }

    function _requireUnderlyingAsset(address asset) internal view {
        if (asset != underlyingAsset) revert InvalidParam();
    }
}
