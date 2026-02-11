// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @dev Empty compilation unit to include TransparentUpgradeableProxy artifact in this workspace.
 */
contract ProxyImports {
    function name() external pure returns (string memory) {
        return "proxy-imports";
    }
}
