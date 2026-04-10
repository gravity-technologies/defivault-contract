// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStkGhoStaking} from "../external/IStkGhoStaking.sol";

interface IMockMintableErc20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockStkGho
 * @notice Test-only live-surface stkGHO mock with configurable exchange rate.
 */
contract MockStkGho is ERC20, IStkGhoStaking {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant UNSTAKE_WINDOW = type(uint256).max;

    error InvalidParam();
    error InsufficientCooldown();

    address public immutable override STAKED_TOKEN;
    uint256 public assetsPerShareWad = WAD;
    uint256 private _cooldownSeconds;

    mapping(address user => uint40 timestamp) public cooldownStart;

    constructor(address gho_) ERC20("Staked GHO", "stkGHO") {
        if (gho_ == address(0)) revert InvalidParam();
        STAKED_TOKEN = gho_;
    }

    function mint(address to, uint256 amount) external {
        IMockMintableErc20(STAKED_TOKEN).mint(address(this), previewRedeem(amount));
        _mint(to, amount);
    }

    function setAssetsPerShareWad(uint256 assetsPerShareWad_) external {
        if (assetsPerShareWad_ == 0) revert InvalidParam();
        assetsPerShareWad = assetsPerShareWad_;
        uint256 requiredBacking = previewRedeem(totalSupply());
        uint256 currentBacking = IERC20(STAKED_TOKEN).balanceOf(address(this));
        if (requiredBacking > currentBacking) {
            IMockMintableErc20(STAKED_TOKEN).mint(address(this), requiredBacking - currentBacking);
        }
    }

    function setCooldownSeconds(uint256 cooldownSeconds_) external {
        _cooldownSeconds = cooldownSeconds_;
    }

    function EXCHANGE_RATE_UNIT() external pure override returns (uint256 unit) {
        return WAD;
    }

    function getExchangeRate() external view override returns (uint216 exchangeRate) {
        exchangeRate = uint216(Math.mulDiv(WAD, WAD, assetsPerShareWad));
    }

    function getCooldownSeconds() external view override returns (uint256 cooldownSeconds) {
        return _cooldownSeconds;
    }

    function previewStake(uint256 assets) public view override returns (uint256 shares) {
        shares = Math.mulDiv(assets, WAD, assetsPerShareWad);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256 assets) {
        assets = Math.mulDiv(shares, assetsPerShareWad, WAD);
    }

    function stake(address to, uint256 amount) external override {
        if (to == address(0) || amount == 0) revert InvalidParam();

        uint256 shares = previewStake(amount);
        if (shares == 0) revert InvalidParam();

        IERC20(STAKED_TOKEN).safeTransferFrom(msg.sender, address(this), amount);
        _mint(to, shares);
    }

    function cooldown() external override {
        if (balanceOf(msg.sender) == 0) revert InvalidParam();
        cooldownStart[msg.sender] = uint40(block.timestamp);
    }

    function redeem(address to, uint256 amount) external override {
        if (to == address(0) || amount == 0) revert InvalidParam();
        if (_cooldownSeconds != 0) {
            uint40 start = cooldownStart[msg.sender];
            if (start == 0 || block.timestamp < uint256(start) + _cooldownSeconds) {
                revert InsufficientCooldown();
            }
            if (block.timestamp > uint256(start) + _cooldownSeconds + UNSTAKE_WINDOW) {
                revert InsufficientCooldown();
            }
        }

        uint256 assets = previewRedeem(amount);
        if (assets == 0) revert InvalidParam();

        _burn(msg.sender, amount);
        IERC20(STAKED_TOKEN).safeTransfer(to, assets);
    }
}
