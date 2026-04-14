// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SGHOStrategy} from "../strategies/SGHOStrategy.sol";

/**
 * @title SGHOStrategyUpgradeMock
 * @notice Test-only beacon upgrade target that preserves layout and exposes a version marker.
 */
contract SGHOStrategyUpgradeMock is SGHOStrategy {
    function upgradeVersion() external pure returns (uint256) {
        return 2;
    }
}
