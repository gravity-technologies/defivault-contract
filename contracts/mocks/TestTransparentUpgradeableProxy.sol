// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @dev Thin wrapper around OpenZeppelin TransparentUpgradeableProxy for tests.
 * Keeps proxy deployment simple in suites that validate upgradeable contract behavior.
 */
contract TestTransparentUpgradeableProxy is TransparentUpgradeableProxy {
    constructor(
        address logic,
        address initialOwner,
        bytes memory data
    ) TransparentUpgradeableProxy(logic, initialOwner, data) {}
}
