// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IWithdrawalFeeTreasury
 * @notice Treasury reimbursement surface used by vaults for exact strategy fee top-ups.
 */
interface IWithdrawalFeeTreasury {
    /**
     * @notice Marker method used to verify that an address implements the treasury reimbursement surface.
     * @return selector The `isWithdrawalFeeTreasury()` selector.
     */
    function isWithdrawalFeeTreasury() external pure returns (bytes4 selector);

    /**
     * @notice Returns remaining reimbursement budget for one `(strategy, token)` tuple.
     * @param strategy Strategy lane whose budget should be read.
     * @param token Principal token for the lane.
     * @return remainingBudget Remaining same-token reimbursement budget for the tuple.
     */
    function reimbursementConfig(address strategy, address token) external view returns (uint256 remainingBudget);

    /**
     * @notice Returns whether `vault` may pull reimbursements from this treasury.
     * @param vault Candidate vault caller.
     * @return allowed Whether `vault` may call reimbursement entrypoints.
     */
    function isAuthorizedVault(address vault) external view returns (bool allowed);

    /**
     * @notice Transfers `amount` of `token` to `recipient` as a fee reimbursement.
     * @dev Callers are expected to be authorized vaults. Treasury implementations should return `0` when
     * reimbursement is over budget or otherwise unavailable for the requested lane.
     * @param token ERC20 token to reimburse.
     * @param strategy Strategy lane whose reimbursement budget should be charged.
     * @param recipient Recipient that receives the reimbursement.
     * @param amount Exact reimbursement amount requested by the vault.
     * @return reimbursed Amount the treasury transferred. Expected to be either `amount` or `0`.
     */
    function reimburseFee(
        address token,
        address strategy,
        address recipient,
        uint256 amount
    ) external returns (uint256 reimbursed);
}
