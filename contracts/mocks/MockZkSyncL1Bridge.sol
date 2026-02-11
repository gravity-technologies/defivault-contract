// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IZkSyncL1Bridge} from "../external/IZkSyncL1Bridge.sol";

/**
 * @dev zkSync L1 bridge mock for adapter tests.
 * Records deposit parameters and supports optional ETH refund behavior back to caller.
 */
contract MockZkSyncL1Bridge is IZkSyncL1Bridge {
    using SafeERC20 for IERC20;

    error InvalidParam();
    error RefundFailed();

    address public lastL2Receiver;
    address public lastL1Token;
    uint256 public lastAmount;
    uint256 public lastL2TxGasLimit;
    uint256 public lastL2TxGasPerPubdataByte;
    address public lastRefundRecipient;
    uint256 public lastMsgValue;
    bytes32 public lastTxHash;
    uint256 public depositCount;

    bool public refundEnabled;
    uint256 public refundAmount;

    function setRefundBehavior(bool enabled, uint256 amount) external {
        refundEnabled = enabled;
        refundAmount = amount;
    }

    function deposit(
        address _l2Receiver,
        address _l1Token,
        uint256 _amount,
        uint256 _l2TxGasLimit,
        uint256 _l2TxGasPerPubdataByte,
        address _refundRecipient
    ) external payable returns (bytes32 txHash) {
        if (
            _l2Receiver == address(0) ||
            _l1Token == address(0) ||
            _amount == 0 ||
            _l2TxGasLimit == 0 ||
            _l2TxGasPerPubdataByte == 0 ||
            _refundRecipient == address(0)
        ) revert InvalidParam();

        IERC20(_l1Token).safeTransferFrom(msg.sender, address(this), _amount);

        lastL2Receiver = _l2Receiver;
        lastL1Token = _l1Token;
        lastAmount = _amount;
        lastL2TxGasLimit = _l2TxGasLimit;
        lastL2TxGasPerPubdataByte = _l2TxGasPerPubdataByte;
        lastRefundRecipient = _refundRecipient;
        lastMsgValue = msg.value;
        depositCount += 1;
        txHash = keccak256(
            abi.encodePacked(
                depositCount,
                _l2Receiver,
                _l1Token,
                _amount,
                _l2TxGasLimit,
                _l2TxGasPerPubdataByte,
                _refundRecipient,
                msg.value
            )
        );
        lastTxHash = txHash;

        if (refundEnabled) {
            uint256 amountToRefund = refundAmount;
            if (amountToRefund > msg.value) amountToRefund = msg.value;
            if (amountToRefund != 0) {
                (bool ok, ) = msg.sender.call{value: amountToRefund}("");
                if (!ok) revert RefundFailed();
            }
        }
    }

    receive() external payable {}
}
