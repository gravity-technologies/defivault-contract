// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IL1SharedBridge
 * @notice Minimal shared-bridge claim surface used for failed-deposit recovery.
 * @dev Signature follows zkSync Era `L1SharedBridge.claimFailedDeposit`.
 */
interface IL1SharedBridge {
    /**
     * @notice Claims a failed L1 -> L2 deposit back to the original deposit sender.
     * @param chainId Target L2 chain id of the failed deposit.
     * @param depositSender Original L1 sender of the failed deposit.
     * @param l1Token L1 token address for the failed deposit (`address(0)` for native ETH).
     * @param amount Deposited amount to reclaim.
     * @param l2TxHash Canonical L2 transaction hash for the failed deposit.
     * @param l2BatchNumber Batch number containing the failed deposit.
     * @param l2MessageIndex Message index within the batch.
     * @param l2TxNumberInBatch Transaction number within the batch.
     * @param merkleProof Merkle proof authorizing the failed-deposit claim.
     */
    function claimFailedDeposit(
        uint256 chainId,
        address depositSender,
        address l1Token,
        uint256 amount,
        bytes32 l2TxHash,
        uint256 l2BatchNumber,
        uint256 l2MessageIndex,
        uint16 l2TxNumberInBatch,
        bytes32[] calldata merkleProof
    ) external;
}
