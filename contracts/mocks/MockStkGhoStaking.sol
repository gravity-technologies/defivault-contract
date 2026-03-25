// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStkGhoStaking} from "../external/IStkGhoStaking.sol";

interface IMockMintableErc20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockStkGhoStaking
 * @notice Test-only share-priced GHO <-> stkGHO staking adapter.
 */
contract MockStkGhoStaking is IStkGhoStaking {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    error InvalidParam();

    address public immutable gho;
    address public immutable stkGho;
    uint256 public assetsPerShareWad = WAD;

    constructor(address gho_, address stkGho_) {
        if (gho_ == address(0) || stkGho_ == address(0)) revert InvalidParam();
        gho = gho_;
        stkGho = stkGho_;
    }

    function setAssetsPerShareWad(uint256 assetsPerShareWad_) external {
        if (assetsPerShareWad_ == 0) revert InvalidParam();
        assetsPerShareWad = assetsPerShareWad_;
    }

    function convertToAssets(uint256 shares) external view returns (uint256 assets) {
        return _convertToAssets(shares);
    }

    function previewWithdraw(uint256 assets) external view returns (uint256 shares) {
        return _previewWithdraw(assets);
    }

    function stake(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0 || receiver == address(0)) revert InvalidParam();

        shares = (assets * WAD) / assetsPerShareWad;
        if (shares == 0) revert InvalidParam();
        IERC20(gho).safeTransferFrom(msg.sender, address(this), assets);
        IMockMintableErc20(stkGho).mint(receiver, shares);
        return shares;
    }

    function unstake(uint256 shares, address receiver) external returns (uint256 assets) {
        if (shares == 0 || receiver == address(0)) revert InvalidParam();

        assets = _convertToAssets(shares);
        if (assets == 0) revert InvalidParam();
        IERC20(stkGho).safeTransferFrom(msg.sender, address(this), shares);
        IMockMintableErc20(gho).mint(receiver, assets);
        return assets;
    }

    function _convertToAssets(uint256 shares) internal view returns (uint256 assets) {
        return (shares * assetsPerShareWad) / WAD;
    }

    function _previewWithdraw(uint256 assets) internal view returns (uint256 shares) {
        return (assets * WAD + (assetsPerShareWad - 1)) / assetsPerShareWad;
    }
}
