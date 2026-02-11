// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

contract MockYieldStrategy is IYieldStrategy {
    mapping(address token => uint256 amount) public mockedAssets;
    mapping(address token => bool value) public revertAssets;
    mapping(address token => bool value) public maxAssets;

    function name() external pure override returns (string memory) {
        return "MockYieldStrategy";
    }

    function setAssets(address token, uint256 amount) external {
        mockedAssets[token] = amount;
    }

    function setRevertAssets(address token, bool value) external {
        revertAssets[token] = value;
    }

    function setMaxAssets(address token, bool value) external {
        maxAssets[token] = value;
    }

    function assets(address token) external view override returns (uint256) {
        if (revertAssets[token]) revert("ASSETS_REVERT");
        if (maxAssets[token]) return type(uint256).max;
        return mockedAssets[token];
    }

    function allocate(address token, uint256 amount) external override {
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert("ALLOCATE_TRANSFER");
        mockedAssets[token] += amount;
    }

    function deallocate(address token, uint256 amount) external override returns (uint256 received) {
        uint256 current = mockedAssets[token];
        received = current < amount ? current : amount;
        mockedAssets[token] = current - received;
        if (received != 0 && !IERC20(token).transfer(msg.sender, received)) revert("DEALLOCATE_TRANSFER");
    }

    function deallocateAll(address token) external override returns (uint256 received) {
        received = mockedAssets[token];
        mockedAssets[token] = 0;
        if (received != 0 && !IERC20(token).transfer(msg.sender, received)) revert("DEALLOCATE_ALL_TRANSFER");
    }
}
