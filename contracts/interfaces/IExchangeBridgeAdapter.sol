// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Bridge/Custody adapter (zkSync native bridge custody, or future chain-specific adapter).
 * Keeps IL1DefiVault chain-agnostic while implementations differ by chain.
 */
interface IExchangeBridgeAdapter {
    /// Move `token` to L2 exchange recipient (vault enforces recipient correctness).
    function sendToL2(address token, uint256 amount, address l2Recipient, bytes calldata data) external;

    /// Whether msg.sender is a trusted bridge/custody caller for onRebalanceFromL2 hooks.
    function isTrustedInboundCaller(address caller) external view returns (bool);
}
