// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockAToken is ERC20 {
    error Unauthorized();

    address public pool;

    constructor() ERC20("Mock AToken", "maToken") {}

    function setPool(address pool_) external {
        if (pool != address(0)) revert Unauthorized();
        pool = pool_;
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
