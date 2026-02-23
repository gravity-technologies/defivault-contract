// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Non-standard ERC20 mock that returns false for transfer/approve operations.
 * Used to validate SafeERC20-protected call paths and failure handling.
 */
contract MockFalseReturnERC20 is ERC20 {
    constructor() ERC20("FalseToken", "FALSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }

    function approve(address, uint256) public pure override returns (bool) {
        return false;
    }
}
