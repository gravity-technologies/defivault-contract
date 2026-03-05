// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title TestNonPayableTreasury
 * @notice Test-only treasury receiver that rejects native ETH transfers.
 * @dev Used to assert native harvest payout reverts with `NativeTransferFailed`.
 */
contract TestNonPayableTreasury {
    fallback() external payable {
        revert("NON_PAYABLE_TREASURY");
    }
}
