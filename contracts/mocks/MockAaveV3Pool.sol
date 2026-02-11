// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveV3Pool} from "../external/IAaveV3Pool.sol";

interface IMockAaveV3PoolAToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title MockAaveV3Pool
 * @notice Deterministic Aave pool mock used by strategy unit tests.
 * @dev Supports one reserve and one linked aToken with 1:1 mint/burn semantics,
 *      plus a manual yield hook that mints additional aToken balance.
 */
contract MockAaveV3Pool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    error InvalidParam();

    address public immutable underlying;
    address public aToken;

    constructor(address underlying_) {
        if (underlying_ == address(0)) revert InvalidParam();
        underlying = underlying_;
    }

    /// @notice Binds the aToken used by this mock pool. Can only be set once.
    function setAToken(address aToken_) external {
        if (aToken_ == address(0) || aToken != address(0)) revert InvalidParam();
        aToken = aToken_;
    }

    /// @inheritdoc IAaveV3Pool
    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        if (asset != underlying || onBehalfOf == address(0) || amount == 0 || aToken == address(0)) {
            revert InvalidParam();
        }

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IMockAaveV3PoolAToken(aToken).mint(onBehalfOf, amount);
    }

    /// @inheritdoc IAaveV3Pool
    function withdraw(address asset, uint256 amount, address to) external override returns (uint256 received) {
        if (asset != underlying || to == address(0) || aToken == address(0)) revert InvalidParam();

        uint256 balance = IMockAaveV3PoolAToken(aToken).balanceOf(msg.sender);
        received = amount == type(uint256).max ? balance : amount;
        if (received > balance) received = balance;
        if (received == 0) return 0;

        IMockAaveV3PoolAToken(aToken).burn(msg.sender, received);
        IERC20(asset).safeTransfer(to, received);
    }

    /// @notice Test-only hook to simulate positive yield accrual.
    function accrueYield(address onBehalfOf, uint256 amount) external {
        if (onBehalfOf == address(0) || amount == 0 || aToken == address(0)) revert InvalidParam();
        IMockAaveV3PoolAToken(aToken).mint(onBehalfOf, amount);
    }
}
