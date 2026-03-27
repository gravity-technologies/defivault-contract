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
 * @notice Test-only GSM mock with 1:1 pricing and configurable burn fees on GHO -> asset swaps.
 */
contract MockAaveGsm is IAaveGsm {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_SCALE = 10_000;

    error InvalidParam();

    address public immutable gho;
    mapping(address asset => uint256 feeBps) public burnFeeBps;
    mapping(address asset => uint256 bps) public assetToGhoExecutionBps;
    mapping(address asset => uint256 bps) public ghoToAssetExecutionBps;
    mapping(address asset => uint256 scale) public assetToGhoScale;

    constructor(address gho_) {
        if (gho_ == address(0)) revert InvalidParam();
        gho = gho_;
    }

    function setBurnFeeBps(address asset, uint256 feeBps_) external {
        if (asset == address(0) || feeBps_ >= BPS_SCALE) revert InvalidParam();
        burnFeeBps[asset] = feeBps_;
    }

    function setAssetToGhoExecutionBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        assetToGhoExecutionBps[asset] = bps;
    }

    function setGhoToAssetExecutionBps(address asset, uint256 bps) external {
        if (asset == address(0) || bps > BPS_SCALE) revert InvalidParam();
        ghoToAssetExecutionBps[asset] = bps;
    }

    function setAssetToGhoScale(address asset, uint256 scale_) external {
        if (asset == address(0) || scale_ == 0) revert InvalidParam();
        assetToGhoScale[asset] = scale_;
    }

    function previewSwapAssetToGho(address asset, uint256 assetAmount) external view returns (uint256 ghoOut) {
        if (asset == address(0)) revert InvalidParam();
        return assetAmount * _assetScaleOrDefault(assetToGhoScale[asset]);
    }

    function swapAssetToGho(
        address asset,
        uint256 assetAmount,
        uint256 minGhoOut,
        address recipient
    ) external returns (uint256 ghoOut) {
        if (asset == address(0) || assetAmount == 0 || recipient == address(0)) revert InvalidParam();

        uint256 executionBps = _executionBpsOrDefault(assetToGhoExecutionBps[asset]);
        uint256 scale = _assetScaleOrDefault(assetToGhoScale[asset]);
        ghoOut = (assetAmount * scale * executionBps) / BPS_SCALE;
        if (ghoOut < minGhoOut) revert InvalidParam();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assetAmount);
        IMockMintableToken(gho).mint(recipient, ghoOut);
    }

    function previewSwapGhoToAsset(
        address asset,
        uint256 ghoAmount
    ) external view returns (uint256 assetOut, uint256 fee) {
        if (asset == address(0)) revert InvalidParam();
        uint256 grossAssetAmount = ghoAmount / _assetScaleOrDefault(assetToGhoScale[asset]);
        fee = (grossAssetAmount * burnFeeBps[asset]) / BPS_SCALE;
        assetOut = grossAssetAmount - fee;
    }

    function previewExactAssetOutFromGho(
        address asset,
        uint256 assetAmountOut
    ) external view returns (uint256 ghoIn, uint256 fee) {
        if (asset == address(0)) revert InvalidParam();

        uint256 feeBps_ = burnFeeBps[asset];
        if (feeBps_ >= BPS_SCALE) revert InvalidParam();
        if (assetAmountOut == 0) return (0, 0);

        uint256 grossAssetIn = (assetAmountOut * BPS_SCALE + (BPS_SCALE - feeBps_ - 1)) / (BPS_SCALE - feeBps_);
        ghoIn = grossAssetIn * _assetScaleOrDefault(assetToGhoScale[asset]);
        fee = grossAssetIn - assetAmountOut;
    }

    function swapGhoToAsset(
        address asset,
        uint256 ghoAmount,
        uint256 minAssetOut,
        address recipient
    ) external returns (uint256 assetOut, uint256 fee) {
        if (asset == address(0) || ghoAmount == 0 || recipient == address(0)) revert InvalidParam();

        uint256 grossAssetAmount = ghoAmount / _assetScaleOrDefault(assetToGhoScale[asset]);
        fee = (grossAssetAmount * burnFeeBps[asset]) / BPS_SCALE;
        uint256 previewAssetOut = grossAssetAmount - fee;
        uint256 executionBps = _executionBpsOrDefault(ghoToAssetExecutionBps[asset]);
        assetOut = (previewAssetOut * executionBps) / BPS_SCALE;
        if (assetOut < minAssetOut) revert InvalidParam();

        IERC20(gho).safeTransferFrom(msg.sender, address(this), ghoAmount);
        IMockMintableToken(asset).mint(recipient, assetOut);
    }

    function _executionBpsOrDefault(uint256 configuredBps) internal pure returns (uint256 executionBps) {
        return configuredBps == 0 ? BPS_SCALE : configuredBps;
    }

    function _assetScaleOrDefault(uint256 configuredScale) internal pure returns (uint256 scale_) {
        return configuredScale == 0 ? 1 : configuredScale;
    }
}
