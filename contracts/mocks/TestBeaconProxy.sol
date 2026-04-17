// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

/**
 * @title TestBeaconProxy
 * @notice Test-only beacon proxy wrapper for local Hardhat artifact-based deployments.
 * @dev Production deployments should use OpenZeppelin BeaconProxy directly via deployment tooling.
 */
contract TestBeaconProxy is BeaconProxy {
    constructor(address beacon, bytes memory data) BeaconProxy(beacon, data) {}
}
