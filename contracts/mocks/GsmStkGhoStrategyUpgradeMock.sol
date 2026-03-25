// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {GsmStkGhoStrategy} from "../strategies/GsmStkGhoStrategy.sol";

/**
 * @title GsmStkGhoStrategyUpgradeMock
 * @notice Test-only beacon upgrade target that preserves layout and exposes a version marker.
 */
contract GsmStkGhoStrategyUpgradeMock is GsmStkGhoStrategy {
    function upgradeVersion() external pure returns (uint256) {
        return 2;
    }
}
