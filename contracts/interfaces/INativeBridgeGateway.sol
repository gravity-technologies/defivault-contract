// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title INativeBridgeGateway
 * @notice Minimal interface the vault uses to bridge native ETH through an external gateway.
 */
interface INativeBridgeGateway {
    /**
     * @notice Bridges native ETH from L1 to L2 using wrapped-native and the fee token already held by the gateway.
     * @param chainId Target L2 chain id.
     * @param l2GasLimit L2 gas limit for the request.
     * @param l2GasPerPubdataByteLimit L2 pubdata gas limit setting.
     * @param l2Recipient L2 recipient for bridged native ETH.
     * @param refundRecipient L2 address that receives any refunded bridge execution value.
     * @param amount Native ETH amount to bridge.
     * @param baseCost Base-token `mintValue` required by BridgeHub.
     * @return txHash L2 transaction hash returned by BridgeHub.
     */
    function bridgeNativeToL2(
        uint256 chainId,
        uint256 l2GasLimit,
        uint256 l2GasPerPubdataByteLimit,
        address l2Recipient,
        address refundRecipient,
        uint256 amount,
        uint256 baseCost
    ) external returns (bytes32 txHash);
}
