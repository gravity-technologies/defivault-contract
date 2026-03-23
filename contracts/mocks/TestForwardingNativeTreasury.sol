// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title TestForwardingNativeTreasury
 * @notice Test-only treasury receiver that forwards received native ETH to a downstream recipient.
 * @dev Used to prove harvest payout accounting does not depend on the recipient retaining ETH.
 */
contract TestForwardingNativeTreasury {
    error InvalidParam();
    error ForwardFailed();

    address public immutable downstreamRecipient;

    constructor(address downstreamRecipient_) {
        if (downstreamRecipient_ == address(0)) revert InvalidParam();
        downstreamRecipient = downstreamRecipient_;
    }

    receive() external payable {
        (bool ok, ) = downstreamRecipient.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
    }
}
