// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {AaveV3StrategyV2} from "../strategies/AaveV3StrategyV2.sol";

/**
 * @title AaveV3StrategyV2UpgradeMock
 * @notice Test-only beacon upgrade target that preserves layout and exposes a version marker.
 */
contract AaveV3StrategyV2UpgradeMock is AaveV3StrategyV2 {
    function upgradeVersion() external pure returns (uint256) {
        return 2;
    }
}
