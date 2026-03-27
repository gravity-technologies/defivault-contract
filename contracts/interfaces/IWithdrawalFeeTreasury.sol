// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IWithdrawalFeeTreasury
 * @notice Minimal treasury reimbursement surface used by vaults for exact strategy exit-fee top-ups.
 */
interface IWithdrawalFeeTreasury {
    /**
     * @notice Marker method used to verify that an address implements the withdrawal-fee treasury surface.
     * @return selector The `isWithdrawalFeeTreasury()` selector.
     */
    function isWithdrawalFeeTreasury() external pure returns (bytes4 selector);

    /**
     * @notice Transfers `amount` of `token` to `recipient` as a withdrawal-fee reimbursement.
     * @dev Callers are expected to be authorized vaults. Treasury implementations should return `0` when
     * reimbursement is disabled, over budget, or otherwise unavailable for the requested strategy lane.
     * @param token ERC20 token to reimburse.
     * @param strategy Strategy lane whose reimbursement budget should be charged.
     * @param recipient Recipient that receives the reimbursement.
     * @param amount Exact reimbursement amount requested by the strategy.
     * @return reimbursed Amount the treasury transferred. Expected to be either `amount` or `0`.
     */
    function reimburseWithdrawalFee(
        address token,
        address strategy,
        address recipient,
        uint256 amount
    ) external returns (uint256 reimbursed);
}
