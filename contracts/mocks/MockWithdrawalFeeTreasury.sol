// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";

/**
 * @title MockWithdrawalFeeTreasury
 * @notice Test-only treasury source for fee reimbursement flows.
 */
contract MockWithdrawalFeeTreasury is IFeeReimburser {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_SCALE = 10_000;

    error InvalidParam();
    error ForcedRevert();

    event FeeReimbursed(
        address indexed strategy,
        address indexed token,
        address recipient,
        uint256 amount,
        uint256 remainingBudget
    );

    bool public shouldRevert;
    mapping(address token => uint256 shortPayBps) public shortPayBps;
    mapping(address vault => bool authorizedVaults) public authorizedVaults;
    mapping(address strategy => mapping(address token => uint256 budget)) public reimbursementBudget;

    function isFeeReimburser() external pure override returns (bytes4 selector) {
        return IFeeReimburser.isFeeReimburser.selector;
    }

    function reimbursementConfig(
        address strategy,
        address token
    ) external view override returns (uint256 remainingBudget) {
        return reimbursementBudget[strategy][token];
    }

    function isAuthorizedVault(address vault) external view override returns (bool allowed) {
        return authorizedVaults[vault];
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setReimbursementConfig(address strategy, address token, uint256 budget) external {
        if (strategy == address(0) || token == address(0)) revert InvalidParam();
        reimbursementBudget[strategy][token] = budget;
    }

    function setAuthorizedVault(address vault, bool allowed) external {
        if (vault == address(0)) revert InvalidParam();
        authorizedVaults[vault] = allowed;
    }

    function setShortPayBps(address token, uint256 bps) external {
        if (token == address(0) || bps > BPS_SCALE) revert InvalidParam();
        shortPayBps[token] = bps;
    }

    function reimburseFee(
        address token,
        address strategy,
        address recipient,
        uint256 amount
    ) public override returns (uint256 reimbursed) {
        if (shouldRevert) revert ForcedRevert();
        if (token == address(0) || strategy == address(0) || recipient == address(0)) revert InvalidParam();
        if (!authorizedVaults[msg.sender]) return 0;
        if (reimbursementBudget[strategy][token] < amount) return 0;

        reimbursed = amount;
        uint256 bps = shortPayBps[token];
        if (bps != 0) {
            reimbursed = (amount * (BPS_SCALE - bps)) / BPS_SCALE;
        }

        if (reimbursed == 0 || reimbursed != amount) return 0;
        reimbursementBudget[strategy][token] -= reimbursed;
        IERC20(token).safeTransfer(recipient, reimbursed);
        emit FeeReimbursed(strategy, token, recipient, reimbursed, reimbursementBudget[strategy][token]);
    }

    receive() external payable {}
}
