// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IMockMintableAsset {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockSgho
 * @notice Test-only ERC4626-like sGHO mock with configurable index and redeemable liquidity.
 */
contract MockSgho is ERC20, IERC4626 {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;

    error InvalidParam();
    error InsufficientLiquidity();
    error WithdrawalsPaused();

    IERC20 private immutable _assetToken;
    uint256 public assetsPerShareWad = WAD;
    uint256 public withdrawalLimit = type(uint256).max;
    bool public withdrawalsPaused;

    constructor(address asset_) ERC20("Savings GHO", "sGHO") {
        if (asset_ == address(0)) revert InvalidParam();
        _assetToken = IERC20(asset_);
    }

    function asset() public view returns (address assetTokenAddress) {
        return address(_assetToken);
    }

    function totalAssets() public view returns (uint256 totalManagedAssets) {
        return convertToAssets(totalSupply());
    }

    function convertToShares(uint256 assets) public view returns (uint256 shares) {
        shares = Math.mulDiv(assets, WAD, assetsPerShareWad, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view returns (uint256 assets) {
        assets = Math.mulDiv(shares, assetsPerShareWad, WAD, Math.Rounding.Floor);
    }

    function maxDeposit(address) public view returns (uint256 maxAssets) {
        return withdrawalsPaused ? 0 : type(uint256).max;
    }

    function maxMint(address receiver) public view returns (uint256 maxShares) {
        return convertToShares(maxDeposit(receiver));
    }

    function maxWithdraw(address owner) public view returns (uint256 maxAssets) {
        if (withdrawalsPaused) return 0;
        uint256 ownerAssets = convertToAssets(balanceOf(owner));
        uint256 backing = _assetToken.balanceOf(address(this));
        maxAssets = ownerAssets < backing ? ownerAssets : backing;
        if (withdrawalLimit < maxAssets) maxAssets = withdrawalLimit;
    }

    function maxRedeem(address owner) public view returns (uint256 maxShares) {
        uint256 ownerShares = balanceOf(owner);
        uint256 sharesForAssets = previewWithdraw(maxWithdraw(owner));
        return ownerShares < sharesForAssets ? ownerShares : sharesForAssets;
    }

    function previewDeposit(uint256 assets) public view returns (uint256 shares) {
        shares = convertToShares(assets);
    }

    function previewMint(uint256 shares) public view returns (uint256 assets) {
        assets = Math.mulDiv(shares, assetsPerShareWad, WAD, Math.Rounding.Ceil);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256 shares) {
        shares = Math.mulDiv(assets, WAD, assetsPerShareWad, Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view returns (uint256 assets) {
        assets = convertToAssets(shares);
    }

    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {
        if (receiver == address(0) || assets == 0 || withdrawalsPaused) revert InvalidParam();
        shares = previewDeposit(assets);
        if (shares == 0) revert InvalidParam();

        _assetToken.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) public returns (uint256 assets) {
        if (receiver == address(0) || shares == 0 || withdrawalsPaused) revert InvalidParam();
        assets = previewMint(shares);
        if (assets == 0) revert InvalidParam();

        _assetToken.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) public returns (uint256 shares) {
        if (receiver == address(0) || owner == address(0) || assets == 0) revert InvalidParam();
        if (withdrawalsPaused) revert WithdrawalsPaused();
        if (assets > maxWithdraw(owner)) revert InsufficientLiquidity();

        shares = previewWithdraw(assets);
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);

        _burn(owner, shares);
        _assetToken.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) public returns (uint256 assets) {
        if (receiver == address(0) || owner == address(0) || shares == 0) revert InvalidParam();
        if (withdrawalsPaused) revert WithdrawalsPaused();

        assets = previewRedeem(shares);
        if (assets > maxWithdraw(owner)) revert InsufficientLiquidity();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);

        _burn(owner, shares);
        _assetToken.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function setAssetsPerShareWad(uint256 assetsPerShareWad_) external {
        if (assetsPerShareWad_ == 0) revert InvalidParam();
        assetsPerShareWad = assetsPerShareWad_;
    }

    function setWithdrawalLimit(uint256 withdrawalLimit_) external {
        withdrawalLimit = withdrawalLimit_;
    }

    function setWithdrawalsPaused(bool paused_) external {
        withdrawalsPaused = paused_;
    }

    function mintBacking(uint256 amount) external {
        IMockMintableAsset(address(_assetToken)).mint(address(this), amount);
    }

    function drainBacking(address to, uint256 amount) external {
        if (to == address(0)) revert InvalidParam();
        _assetToken.safeTransfer(to, amount);
    }
}
