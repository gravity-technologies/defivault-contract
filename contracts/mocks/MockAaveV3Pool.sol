// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMockAaveV3AToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title MockAaveV3Pool
 * @notice Minimal Aave pool mock used by strategy unit tests.
 * @dev Supports only `supply` and `withdraw` against one underlying reserve and one linked
 *      mock aToken, enough to validate strategy accounting and deallocation behavior.
 */
contract MockAaveV3Pool {
    using SafeERC20 for IERC20;

    address public immutable underlying;
    address public aToken;

    error InvalidParam();

    constructor(address underlying_) {
        if (underlying_ == address(0)) revert InvalidParam();
        underlying = underlying_;
    }

    function setAToken(address aToken_) external {
        if (aToken_ == address(0) || aToken != address(0)) revert InvalidParam();
        aToken = aToken_;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        if (asset != underlying || onBehalfOf == address(0) || amount == 0 || aToken == address(0)) {
            revert InvalidParam();
        }
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IMockAaveV3AToken(aToken).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256 received) {
        if (asset != underlying || to == address(0) || aToken == address(0)) revert InvalidParam();

        uint256 current = IMockAaveV3AToken(aToken).balanceOf(msg.sender);
        if (amount == type(uint256).max || amount > current) {
            received = current;
        } else {
            received = amount;
        }

        if (received == 0) return 0;

        IMockAaveV3AToken(aToken).burn(msg.sender, received);
        IERC20(asset).safeTransfer(to, received);
    }
}
