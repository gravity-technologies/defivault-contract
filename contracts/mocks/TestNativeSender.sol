// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title TestNativeSender
 * @notice Test helper that exercises different native ETH send patterns.
 */
contract TestNativeSender {
    bool public lastSendResult;
    error NativeTransferFailed();

    /**
     * @notice Sends ETH with a 2300-gas native call, matching Solidity's old `transfer` behavior.
     */
    function sendViaTransfer(address payable recipient, uint256 amount) external {
        (bool ok, ) = recipient.call{value: amount, gas: 2300}("");
        if (!ok) revert NativeTransferFailed();
    }

    /**
     * @notice Sends ETH with a 2300-gas native call and records the result, matching Solidity's old `send`.
     */
    function sendViaSend(address payable recipient, uint256 amount) external {
        (lastSendResult, ) = recipient.call{value: amount, gas: 2300}("");
    }

    /**
     * @notice Sends ETH with a full-gas native call.
     */
    function sendViaCall(address payable recipient, uint256 amount) external returns (bool ok, bytes memory data) {
        (ok, data) = recipient.call{value: amount}("");
    }

    receive() external payable {}
}
