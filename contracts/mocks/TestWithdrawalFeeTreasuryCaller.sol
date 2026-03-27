// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IWithdrawalFeeTreasury} from "../interfaces/IWithdrawalFeeTreasury.sol";

/**
 * @title TestWithdrawalFeeTreasuryCaller
 * @notice Test-only helper that calls a withdrawal-fee treasury as a contract strategy caller.
 */
contract TestWithdrawalFeeTreasuryCaller {
    function callReimburse(
        address treasury,
        address token,
        address strategy,
        address recipient,
        uint256 amount
    ) external returns (uint256 reimbursed) {
        return IWithdrawalFeeTreasury(treasury).reimburseWithdrawalFee(token, strategy, recipient, amount);
    }
}
