// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

contract MockRevertingStrategy is IYieldStrategy {
    function name() external pure returns (string memory) {
        return "REVERTING_STRATEGY";
    }

    function assets(address) external pure returns (uint256) {
        revert("ASSETS_REVERT");
    }

    function allocate(address, uint256, bytes calldata) external pure {
        revert("ALLOCATE_REVERT");
    }

    function deallocate(address, uint256, bytes calldata) external pure returns (uint256) {
        revert("DEALLOCATE_REVERT");
    }

    function deallocateAll(address, bytes calldata) external pure returns (uint256) {
        revert("DEALLOCATE_ALL_REVERT");
    }
}
