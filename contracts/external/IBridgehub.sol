// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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

interface IBridgehub {
    function sharedBridge() external view returns (address);

    function l2TransactionBaseCost(
        uint256 chainId,
        uint256 gasPrice,
        uint256 l2GasLimit,
        uint256 l2GasPerPubdataByteLimit
    ) external view returns (uint256);

    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata request
    ) external payable returns (bytes32 canonicalTxHash);
}
