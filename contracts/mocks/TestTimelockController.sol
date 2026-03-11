// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @dev Test-only wrapper to ensure TimelockController artifacts are compiled and
 * available for unit tests that exercise delayed governance flows.
 */
contract TestTimelockController is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
