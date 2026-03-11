// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title INativeBridgeGateway
 * @notice Minimal vault-facing interface for native bridge execution through an external gateway.
 */
interface INativeBridgeGateway {
    /**
     * @notice Submits a native ETH L1 -> L2 bridge request using gateway-held wrapped-native and base token.
     * @param chainId Target L2 chain id.
     * @param l2GasLimit L2 gas limit for the request.
     * @param l2GasPerPubdataByteLimit L2 pubdata gas setting.
     * @param l2Recipient L2 recipient for bridged native ETH.
     * @param refundRecipient L2 recipient for refunded bridge execution value.
     * @param amount Native ETH amount to bridge.
     * @param baseCost Base-token `mintValue` required by BridgeHub.
     * @return txHash Canonical L2 transaction hash returned by BridgeHub.
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
