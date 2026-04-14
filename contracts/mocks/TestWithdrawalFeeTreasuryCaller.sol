// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";

/**
 * @title TestWithdrawalFeeTreasuryCaller
 * @notice Test-only helper that calls a fee reimburser as a contract strategy caller.
 */
contract TestWithdrawalFeeTreasuryCaller {
    function callReimburse(
        address treasury,
        address token,
        address strategy,
        address recipient,
        uint256 amount
    ) external returns (uint256 reimbursed) {
        strategy;
        return IFeeReimburser(treasury).reimburseFee(token, recipient, amount);
    }
}
