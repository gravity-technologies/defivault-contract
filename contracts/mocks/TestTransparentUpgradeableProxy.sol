// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @title TestTransparentUpgradeableProxy
 * @notice Test-only proxy wrapper for local Hardhat artifact-based deployments.
 * @dev Production deployments should use OpenZeppelin TransparentUpgradeableProxy directly via deployment tooling.
 */
contract TestTransparentUpgradeableProxy is TransparentUpgradeableProxy {
    constructor(
        address logic,
        address initialOwner,
        bytes memory data
    ) TransparentUpgradeableProxy(logic, initialOwner, data) {}
}
