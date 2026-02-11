// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockAaveV3AToken
 * @notice Minimal aToken mock for unit tests.
 * @dev Exposes Aave-style `UNDERLYING_ASSET_ADDRESS` and `POOL` getters and restricts
 *      mint/burn to the configured mock pool so test flows mirror pool-controlled supply/withdraw.
 */
contract MockAaveV3AToken is ERC20 {
    address public immutable UNDERLYING_ASSET_ADDRESS;
    address public immutable POOL;

    error Unauthorized();

    constructor(address underlying_, address pool_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        UNDERLYING_ASSET_ADDRESS = underlying_;
        POOL = pool_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != POOL) revert Unauthorized();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != POOL) revert Unauthorized();
        _burn(from, amount);
    }
}
