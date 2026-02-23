// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock Aave aToken used in tests.
 * Exposes Aave metadata getters and restricts mint/burn to the configured mock pool.
 */
contract MockAToken is ERC20 {
    error Unauthorized();

    address public pool;
    address public underlyingAsset;

    constructor() ERC20("Mock AToken", "maToken") {}

    function setPool(address pool_) external {
        if (pool != address(0)) revert Unauthorized();
        pool = pool_;
    }

    function setUnderlyingAsset(address underlying_) external {
        if (underlyingAsset != address(0)) revert Unauthorized();
        underlyingAsset = underlying_;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return underlyingAsset;
    }

    function POOL() external view returns (address) {
        return pool;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != pool) revert Unauthorized();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != pool) revert Unauthorized();
        _burn(from, amount);
    }
}
