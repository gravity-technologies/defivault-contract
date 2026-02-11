// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @dev Test-only helper so local test tooling has a concrete proxy artifact to deploy.
contract TestTransparentUpgradeableProxy is TransparentUpgradeableProxy {
    constructor(
        address logic,
        address initialOwner,
        bytes memory data
    ) TransparentUpgradeableProxy(logic, initialOwner, data) {}
}
