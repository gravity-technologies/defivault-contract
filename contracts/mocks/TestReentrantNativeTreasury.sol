// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";

/**
 * @title TestReentrantNativeTreasury
 * @notice Test-only treasury receiver that attempts reentrancy during native harvest payout.
 * @dev Used to validate vault `nonReentrant` protection on wrapped-native harvest -> ETH transfer branch.
 */
contract TestReentrantNativeTreasury is IFeeReimburser {
    error InvalidParam();

    address public immutable vault;
    bytes public reentryCalldata;
    bool public attemptedReentry;
    bool public reentrySucceeded;
    bytes public lastRevertData;

    constructor(address vault_) {
        if (vault_ == address(0)) revert InvalidParam();
        vault = vault_;
    }

    function isFeeReimburser() external pure override returns (bytes4 selector) {
        return IFeeReimburser.isFeeReimburser.selector;
    }

    function isAuthorizedVault(address) external pure override returns (bool allowed) {
        return true;
    }

    function reimburseFee(address, address, uint256) external pure override returns (uint256 reimbursed) {
        return 0;
    }

    /// @notice Sets calldata used for reentry attempt on next ETH receive.
    function configureReentry(bytes calldata data) external {
        if (data.length < 4) revert InvalidParam();
        reentryCalldata = data;
        attemptedReentry = false;
        reentrySucceeded = false;
        delete lastRevertData;
    }

    receive() external payable {
        attemptedReentry = true;
        (bool ok, bytes memory revertData) = vault.call(reentryCalldata);
        reentrySucceeded = ok;
        if (!ok) lastRevertData = revertData;
    }
}
