// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title TestNativeSender
 * @notice Test helper that exercises different native ETH send patterns.
 */
contract TestNativeSender {
    bool public lastSendResult;

    /**
     * @notice Sends ETH with Solidity's `transfer`.
     */
    function sendViaTransfer(address payable recipient, uint256 amount) external {
        (bool ok, ) = recipient.call{value: amount, gas: 2300}("");
        if (!ok) revert();
    }

    /**
     * @notice Sends ETH with Solidity's `send` and records the result.
     */
    function sendViaSend(address payable recipient, uint256 amount) external {
        (bool ok, ) = recipient.call{value: amount, gas: 2300}("");
        lastSendResult = ok;
    }

    /**
     * @notice Sends ETH with a full-gas native call.
     */
    function sendViaCall(address payable recipient, uint256 amount) external returns (bool ok, bytes memory data) {
        (ok, data) = recipient.call{value: amount}("");
    }

    receive() external payable {}
}
