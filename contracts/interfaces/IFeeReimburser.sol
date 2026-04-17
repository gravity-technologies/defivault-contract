// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IFeeReimburser
 * @notice Treasury reimbursement surface used by vaults for exact strategy fee top-ups.
 */
interface IFeeReimburser {
    /**
     * @notice Marker method used to verify that an address implements the fee reimburser surface.
     * @return selector The `isFeeReimburser()` selector.
     */
    function isFeeReimburser() external pure returns (bytes4 selector);

    /**
     * @notice Returns whether `vault` may pull reimbursements from this treasury.
     * @param vault Candidate vault caller.
     * @return allowed Whether `vault` may call reimbursement entrypoints.
     */
    function isAuthorizedVault(address vault) external view returns (bool allowed);

    /**
     * @notice Transfers `amount` of `token` to `recipient` as a fee reimbursement.
     * @dev Callers are expected to be authorized vaults. Treasury implementations should revert for
     * unauthorized callers and underfunded treasury balance.
     * @param token ERC20 token to reimburse.
     * @param recipient Recipient that receives the reimbursement.
     * @param amount Exact reimbursement amount requested by the vault.
     * @return reimbursed Amount the treasury transferred. Expected to equal `amount` on success.
     */
    function reimburseFee(address token, address recipient, uint256 amount) external returns (uint256 reimbursed);
}
