// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveV3Pool} from "../external/IAaveV3Pool.sol";
import {MockAToken} from "./MockAToken.sol";

/**
 * @dev Deterministic Aave V3 pool mock for strategy tests.
 * Supplies/withdraws underlying 1:1 against MockAToken and provides a manual yield accrual hook.
 */
contract MockAaveV3Pool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    error InvalidParam();

    address public immutable underlying;
    MockAToken public immutable aToken;

    constructor(address underlying_, address aToken_) {
        if (underlying_ == address(0) || aToken_ == address(0)) revert InvalidParam();
        underlying = underlying_;
        aToken = MockAToken(aToken_);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        if (asset != underlying) revert InvalidParam();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256 received) {
        if (asset != underlying) revert InvalidParam();

        uint256 balance = aToken.balanceOf(msg.sender);
        uint256 burnAmount = amount == type(uint256).max ? balance : amount;
        if (burnAmount > balance) burnAmount = balance;
        if (burnAmount == 0) return 0;

        aToken.burn(msg.sender, burnAmount);
        IERC20(asset).safeTransfer(to, burnAmount);
        return burnAmount;
    }

    function accrueYield(address onBehalfOf, uint256 amount) external {
        if (onBehalfOf == address(0) || amount == 0) revert InvalidParam();
        aToken.mint(onBehalfOf, amount);
    }
}
