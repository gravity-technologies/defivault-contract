// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @notice Parameters for Era-style two-bridges L1->L2 request.
 * @param chainId Target L2 chain id.
 * @param mintValue Base-token amount consumed to pay L2 execution/publication costs.
 * @param l2Value Native value forwarded to the L2 call.
 * @param l2GasLimit Gas limit for L2 execution.
 * @param l2GasPerPubdataByteLimit Pubdata gas parameter for L2 transaction pricing.
 * @param refundRecipient Recipient for any refunded base token.
 * @param secondBridgeAddress Secondary bridge address (shared bridge on L1).
 * @param secondBridgeValue Native value sent to secondary bridge call.
 * @param secondBridgeCalldata Encoded deposit calldata for secondary bridge.
 * Reference:
 * https://github.com/matter-labs/era-contracts/blob/main/l1-contracts/contracts/bridgehub/IBridgehub.sol
 */
struct L2TransactionRequestTwoBridgesOuter {
    uint256 chainId;
    uint256 mintValue;
    uint256 l2Value;
    uint256 l2GasLimit;
    uint256 l2GasPerPubdataByteLimit;
    address refundRecipient;
    address secondBridgeAddress;
    uint256 secondBridgeValue;
    bytes secondBridgeCalldata;
}

/**
 * @title IL1ZkSyncBridgeHub
 * @notice Minimal Bridgehub interface consumed by the vault for controlled L1->L2 rebalancing.
 * @dev The vault computes `mintValue` via `l2TransactionBaseCost`, mints GRVT base token,
 * and then submits `requestL2TransactionTwoBridges`. This preserves GRVT's private-chain
 * deposit control model where bridging depends on GRVT-controlled base token availability.
 * Reference:
 * https://github.com/matter-labs/era-contracts/blob/main/l1-contracts/contracts/bridgehub/IBridgehub.sol
 */
interface IL1ZkSyncBridgeHub {
    /**
     * @notice Returns the L1 shared bridge used as the second bridge.
     */
    function sharedBridge() external view returns (address);

    /**
     * @notice Quotes base-token cost for a target L2 transaction.
     * @param chainId Target L2 chain id.
     * @param gasPrice Current L1 gas price used in quote.
     * @param l2GasLimit Gas limit requested for L2 execution.
     * @param l2GasPerPubdataByteLimit Pubdata price parameter.
     * @return Base-token amount required as `mintValue`.
     */
    function l2TransactionBaseCost(
        uint256 chainId,
        uint256 gasPrice,
        uint256 l2GasLimit,
        uint256 l2GasPerPubdataByteLimit
    ) external view returns (uint256);

    /**
     * @notice Requests L1->L2 execution with shared-bridge deposit leg.
     * @param request Two-bridges request payload.
     * @return canonicalTxHash Canonical L2 transaction hash.
     */
    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata request
    ) external payable returns (bytes32 canonicalTxHash);
}
