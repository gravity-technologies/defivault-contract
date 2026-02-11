// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IProxyAdmin
 * @notice Minimal ProxyAdmin interface used by Ignition upgrade modules.
 */
interface IProxyAdmin {
    /**
     * @notice Upgrades a transparent proxy and optionally executes a setup call.
     * @param proxy Proxy address to upgrade.
     * @param implementation New implementation address.
     * @param data Optional calldata for post-upgrade initialization.
     */
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

