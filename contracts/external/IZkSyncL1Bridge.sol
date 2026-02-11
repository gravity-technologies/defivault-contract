// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IZkSyncL1Bridge
 * @notice Minimal interface for the zkSync Era L1 ERC20 bridge used by ZkSyncNativeBridgeAdapter.
 * @dev Covers only the `deposit` function needed for outbound L1 → L2 token transfers.
 *      The full zkSync bridge interface (claim failed deposit, finalize withdrawal, etc.)
 *      is intentionally omitted; those paths are handled off-chain or by separate contracts.
 *
 *      Reference: zkSync Era L1ERC20Bridge / L1SharedBridge `deposit` entry point.
 */
interface IZkSyncL1Bridge {
    /**
     * @notice Initiates a token deposit from L1 to a recipient on L2.
     * @dev Caller must have approved this bridge for at least `_amount` of `_l1Token` before calling.
     *      The bridge pulls tokens from msg.sender, locks them on L1, and triggers an L2 mint.
     *      ETH sent as `msg.value` covers the L2 transaction fee; surplus is refunded to `_refundRecipient`.
     * @param _l2Receiver             L2 address that will receive the minted tokens.
     * @param _l1Token                L1 ERC20 token address to deposit.
     * @param _amount                 Amount of `_l1Token` to deposit (in token's native decimals).
     * @param _l2TxGasLimit           Gas limit for the L2 execution leg of the deposit transaction.
     * @param _l2TxGasPerPubdataByte  Gas price per pubdata byte for the L2 transaction.
     * @param _refundRecipient        L2 address to receive any surplus bridge fee; use zero for msg.sender.
     * @return bytes32                L2 transaction hash of the initiated deposit.
     */
    function deposit(
        address _l2Receiver,
        address _l1Token,
        uint256 _amount,
        uint256 _l2TxGasLimit,
        uint256 _l2TxGasPerPubdataByte,
        address _refundRecipient
    ) external payable returns (bytes32);
}
