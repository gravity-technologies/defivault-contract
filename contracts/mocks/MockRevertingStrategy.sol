// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {StrategyAssetBreakdown} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @dev Strategy mock that always reverts on operational methods.
 * Used to test degraded-mode accounting and emergency unwind skip behavior.
 */
contract MockRevertingStrategy is IYieldStrategy {
    function name() external pure returns (string memory) {
        return "REVERTING_STRATEGY";
    }

    function exactTokenBalance(address) external pure returns (uint256) {
        revert("ASSETS_REVERT");
    }

    function positionBreakdown(address) external pure returns (StrategyAssetBreakdown memory) {
        revert("ASSETS_REVERT");
    }

    function principalBearingExposure(address) external pure returns (uint256) {
        revert("EXPOSURE_REVERT");
    }

    function allocate(address, uint256) external pure {
        revert("ALLOCATE_REVERT");
    }

    function deallocate(address, uint256) external pure returns (uint256) {
        revert("DEALLOCATE_REVERT");
    }

    function deallocateAll(address) external pure returns (uint256) {
        revert("DEALLOCATE_ALL_REVERT");
    }
}
