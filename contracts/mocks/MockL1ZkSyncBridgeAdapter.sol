// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";

/**
 * @dev BridgeHub mock used by vault tests.
 * It records request params and simulates token movement from vault -> L2 recipient.
 */
contract MockL1ZkSyncBridgeAdapter is IL1ZkSyncBridgeHub {
    using SafeERC20 for IERC20;

    error BridgeForcedRevert();
    error InsufficientFee(uint256 requiredFee, uint256 actualFee);
    error InvalidParam();

    address public lastToken;
    uint256 public lastAmount;
    address public lastL2Receiver;
    uint256 public lastL2TxGasLimit;
    uint256 public lastL2TxGasPerPubdataByte;
    address public lastRefundRecipient;
    uint256 public lastFeeValue;
    bytes32 public lastTxHash;
    uint256 public sendCount;
    bool public forceRevert;
    uint256 public minFeeValue;

    function sharedBridge() external view override returns (address) {
        return address(this);
    }

    function l2TransactionBaseCost(uint256, uint256, uint256, uint256) external view override returns (uint256) {
        return minFeeValue;
    }

    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata request
    ) external payable override returns (bytes32 txHash) {
        if (forceRevert) revert BridgeForcedRevert();
        if (request.mintValue < minFeeValue) revert InsufficientFee(minFeeValue, request.mintValue);
        if (request.secondBridgeAddress != address(this)) revert InvalidParam();

        (address token, uint256 amount, address l2Receiver) = abi.decode(
            request.secondBridgeCalldata,
            (address, uint256, address)
        );

        IERC20(token).safeTransferFrom(msg.sender, l2Receiver, amount);

        lastToken = token;
        lastAmount = amount;
        lastL2Receiver = l2Receiver;
        lastL2TxGasLimit = request.l2GasLimit;
        lastL2TxGasPerPubdataByte = request.l2GasPerPubdataByteLimit;
        lastRefundRecipient = request.refundRecipient;
        lastFeeValue = request.mintValue;
        sendCount += 1;
        txHash = keccak256(
            abi.encodePacked(
                sendCount,
                token,
                amount,
                l2Receiver,
                request.l2GasLimit,
                request.l2GasPerPubdataByteLimit,
                request.refundRecipient,
                request.mintValue
            )
        );
        lastTxHash = txHash;
    }

    function setForceRevert(bool enabled) external {
        forceRevert = enabled;
    }

    function setMinFeeValue(uint256 minFeeValue_) external {
        minFeeValue = minFeeValue_;
    }
}
