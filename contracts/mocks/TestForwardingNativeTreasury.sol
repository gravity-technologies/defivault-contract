// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";

/**
 * @title TestForwardingNativeTreasury
 * @notice Test-only treasury receiver that forwards received native ETH to a downstream recipient.
 * @dev Used to prove harvest payout accounting does not depend on the recipient retaining ETH.
 */
contract TestForwardingNativeTreasury is IFeeReimburser {
    error InvalidParam();
    error ForwardFailed();

    address public immutable downstreamRecipient;

    constructor(address downstreamRecipient_) {
        if (downstreamRecipient_ == address(0)) revert InvalidParam();
        downstreamRecipient = downstreamRecipient_;
    }

    function isFeeReimburser() external pure override returns (bytes4 selector) {
        return IFeeReimburser.isFeeReimburser.selector;
    }

    function reimbursementConfig(address, address) external pure override returns (uint256 remainingBudget) {
        return 0;
    }

    function isAuthorizedVault(address) external pure override returns (bool allowed) {
        return true;
    }

    function reimburseFee(address, address, address, uint256) external pure override returns (uint256 reimbursed) {
        return 0;
    }

    receive() external payable {
        (bool ok, ) = downstreamRecipient.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
    }
}
