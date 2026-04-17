// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";

/**
 * @title TestNonPayableTreasury
 * @notice Test-only treasury receiver that rejects native ETH transfers.
 * @dev Used to assert native harvest payout reverts with `NativeTransferFailed`.
 */
contract TestNonPayableTreasury is IFeeReimburser {
    function isFeeReimburser() external pure override returns (bytes4 selector) {
        return IFeeReimburser.isFeeReimburser.selector;
    }

    function isAuthorizedVault(address) external pure override returns (bool allowed) {
        return true;
    }

    function reimburseFee(address, address, uint256) external pure override returns (uint256 reimbursed) {
        return 0;
    }

    receive() external payable {
        revert("NON_PAYABLE_TREASURY");
    }

    fallback() external payable {
        revert("NON_PAYABLE_TREASURY");
    }
}
