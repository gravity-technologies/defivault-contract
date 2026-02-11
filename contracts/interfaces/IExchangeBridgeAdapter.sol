// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Bridge/custody adapter for chain-specific L1 -> L2 flows.
 */
interface IExchangeBridgeAdapter {
    /**
     * Move `token` from vault custody into an L2 deposit flow.
     *
     * Fee model:
     * - Caller MUST supply exact bridge fee as `msg.value`.
     * - Adapter MUST forward full `msg.value` to the underlying bridge `deposit(...)` call.
     * - No internal fee buffering is assumed at adapter level.
     *
     * Expected zkSync mapping:
     * - `_l2Receiver`               <= `l2Receiver`
     * - `_l1Token`                  <= `token`
     * - `_amount`                   <= `amount`
     * - `_l2TxGasLimit`             <= `l2TxGasLimit`
     * - `_l2TxGasPerPubdataByte`    <= `l2TxGasPerPubdataByte`
     * - `_refundRecipient`          <= `refundRecipient`
     */
    function sendToL2(
        address token,
        uint256 amount,
        address l2Receiver,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable returns (bytes32 txHash);

    /// Whether msg.sender is a trusted bridge/custody caller for onRebalanceFromL2 hooks.
    function isTrustedInboundCaller(address caller) external view returns (bool);
}
