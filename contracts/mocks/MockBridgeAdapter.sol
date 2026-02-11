// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IExchangeBridgeAdapter} from "../interfaces/IExchangeBridgeAdapter.sol";

/**
 * @dev Test bridge adapter for vault rebalancing flows.
 * Records last call parameters and supports configurable failure/fee behavior for adversarial tests.
 */
contract MockBridgeAdapter is IExchangeBridgeAdapter {
    using SafeERC20 for IERC20;

    error BridgeForcedRevert();
    error InsufficientFee(uint256 requiredFee, uint256 actualFee);

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
    mapping(address caller => bool trusted) private _trustedInbound;

    function sendToL2(
        address token,
        uint256 amount,
        address l2Receiver,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable returns (bytes32 txHash) {
        if (forceRevert) revert BridgeForcedRevert();
        if (msg.value < minFeeValue) revert InsufficientFee(minFeeValue, msg.value);

        IERC20(token).safeTransferFrom(msg.sender, l2Receiver, amount);

        lastToken = token;
        lastAmount = amount;
        lastL2Receiver = l2Receiver;
        lastL2TxGasLimit = l2TxGasLimit;
        lastL2TxGasPerPubdataByte = l2TxGasPerPubdataByte;
        lastRefundRecipient = refundRecipient;
        lastFeeValue = msg.value;
        sendCount += 1;
        txHash = keccak256(
            abi.encodePacked(
                sendCount,
                token,
                amount,
                l2Receiver,
                l2TxGasLimit,
                l2TxGasPerPubdataByte,
                refundRecipient,
                msg.value
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

    function isTrustedInboundCaller(address caller) external view returns (bool) {
        return _trustedInbound[caller];
    }

    function setTrustedInboundCaller(address caller, bool trusted) external {
        _trustedInbound[caller] = trusted;
    }
}
