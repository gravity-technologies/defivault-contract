// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveV3Pool} from "../external/IAaveV3Pool.sol";
import {MockAToken} from "./MockAToken.sol";

/**
 * @dev Aave V3 pool mock that intentionally consumes only a fraction of supplied funds.
 * Used to test residual-underlying safety checks in AaveV3Strategy.allocate.
 */
contract MockAaveV3PoolPartialFill is IAaveV3Pool {
    using SafeERC20 for IERC20;

    error InvalidParam();

    address public immutable underlying;
    MockAToken public immutable aToken;
    uint16 public fillBps;

    constructor(address underlying_, address aToken_, uint16 fillBps_) {
        if (underlying_ == address(0) || aToken_ == address(0)) revert InvalidParam();
        if (fillBps_ > 10_000) revert InvalidParam();
        underlying = underlying_;
        aToken = MockAToken(aToken_);
        fillBps = fillBps_;
    }

    function setFillBps(uint16 fillBps_) external {
        if (fillBps_ > 10_000) revert InvalidParam();
        fillBps = fillBps_;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        if (asset != underlying || onBehalfOf == address(0)) revert InvalidParam();

        uint256 consumed = (amount * uint256(fillBps)) / 10_000;
        if (consumed == 0 && amount != 0 && fillBps != 0) consumed = 1;

        if (consumed > 0) {
            IERC20(asset).safeTransferFrom(msg.sender, address(this), consumed);
            aToken.mint(onBehalfOf, consumed);
        }
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256 received) {
        if (asset != underlying || to == address(0)) revert InvalidParam();

        uint256 balance = aToken.balanceOf(msg.sender);
        uint256 burnAmount = amount == type(uint256).max ? balance : amount;
        if (burnAmount > balance) burnAmount = balance;
        if (burnAmount == 0) return 0;

        aToken.burn(msg.sender, burnAmount);
        IERC20(asset).safeTransfer(to, burnAmount);
        return burnAmount;
    }
}
