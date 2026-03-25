// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/**
 * @title TestUpgradeableBeacon
 * @notice Test-only beacon wrapper for local Hardhat artifact-based deployments.
 * @dev Production deployments should use OpenZeppelin UpgradeableBeacon directly via deployment tooling.
 */
contract TestUpgradeableBeacon is UpgradeableBeacon {
    constructor(address implementation, address initialOwner) UpgradeableBeacon(implementation, initialOwner) {}
}
