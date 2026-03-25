// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IWithdrawalFeeTreasury} from "../interfaces/IWithdrawalFeeTreasury.sol";

/**
 * @title TestReentrantNativeTreasury
 * @notice Test-only treasury receiver that attempts reentrancy during native harvest payout.
 * @dev Used to validate vault `nonReentrant` protection on wrapped-native harvest -> ETH transfer branch.
 */
contract TestReentrantNativeTreasury is IWithdrawalFeeTreasury {
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

    function isWithdrawalFeeTreasury() external pure override returns (bytes4 selector) {
        return IWithdrawalFeeTreasury.isWithdrawalFeeTreasury.selector;
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
