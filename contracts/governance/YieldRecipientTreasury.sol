// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWithdrawalFeeTreasury} from "../interfaces/IWithdrawalFeeTreasury.sol";

/**
 * @title YieldRecipientTreasury
 * @notice Treasury sink for harvested yield and withdrawal-fee reimbursements.
 * @dev This contract is designed to be set as the vault's `yieldRecipient`.
 *
 * High-level behavior:
 * - It passively receives harvested ERC20 balances and native ETH sent by the vault.
 * - It exposes an exact-or-zero reimbursement hook that authorized vaults can use to top up
 *   strategy withdrawal fees in principal tokens.
 * - Reimbursement policy is configured per `(strategy, token)` with an enable flag and a remaining budget.
 * - Governance retains custody through two-step ownership and can sweep accumulated ERC20/native balances.
 *
 * Security model:
 * - `reimburseWithdrawalFee()` keys caller authorization off `msg.sender`, which is expected to be the calling vault.
 * - Reimbursement policy is keyed by the requested `(strategy, token)` lane.
 * - The contract does not validate strategy economics; it only enforces enablement, remaining budget,
 *   and available treasury balance.
 * - Reimbursement requests are exact-or-zero: attempts that exceed remaining budget or treasury balance
 *   return `0` instead of partially paying.
 */
contract YieldRecipientTreasury is Ownable2Step, ReentrancyGuard, IWithdrawalFeeTreasury {
    using SafeERC20 for IERC20;

    /// @dev Input address or amount is zero or otherwise malformed.
    error InvalidParam();
    /// @dev Native ETH transfer failed.
    error NativeTransferFailed();

    struct ReimbursementConfig {
        bool enabled;
        uint256 remainingBudget;
    }

    /// @dev Vaults allowed to pull reimbursement from this treasury.
    mapping(address vault => bool allowed) private _authorizedVaults;
    /// @dev Reimbursement policy keyed by `(strategy, token)`.
    mapping(address strategy => mapping(address token => ReimbursementConfig config)) private _reimbursementConfigs;

    /// @notice Emitted when vault authorization changes.
    event AuthorizedVaultUpdated(address indexed vault, bool allowed);

    /// @notice Emitted when reimbursement policy changes for one `(strategy, token)` pair.
    event ReimbursementConfigUpdated(
        address indexed strategy,
        address indexed token,
        bool enabled,
        uint256 remainingBudget
    );

    /// @notice Emitted when a strategy reimbursement is paid.
    event WithdrawalFeeReimbursed(
        address indexed strategy,
        address indexed token,
        address indexed recipient,
        uint256 amount,
        uint256 remainingBudget
    );

    /// @notice Emitted when the owner sweeps ERC20 balance out of the treasury.
    event ERC20Withdrawn(address indexed token, address indexed recipient, uint256 amount);

    /// @notice Emitted when the owner sweeps native ETH out of the treasury.
    event NativeWithdrawn(address indexed recipient, uint256 amount);

    /**
     * @notice Initializes treasury ownership.
     * @param initialOwner Account that controls authorization and withdrawals.
     */
    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidParam();
    }

    /// @inheritdoc IWithdrawalFeeTreasury
    function isWithdrawalFeeTreasury() external pure override returns (bytes4 selector) {
        return IWithdrawalFeeTreasury.isWithdrawalFeeTreasury.selector;
    }

    function reimbursementConfig(
        address strategy,
        address token
    ) external view returns (bool enabled, uint256 remainingBudget) {
        if (strategy == address(0) || token == address(0)) revert InvalidParam();
        ReimbursementConfig storage config = _reimbursementConfigs[strategy][token];
        return (config.enabled, config.remainingBudget);
    }

    function isAuthorizedVault(address vault) external view returns (bool allowed) {
        if (vault == address(0)) revert InvalidParam();
        return _authorizedVaults[vault];
    }

    /**
     * @notice Sets whether `vault` may call `reimburseWithdrawalFee`.
     * @param vault Vault caller to authorize or revoke.
     * @param allowed Whether reimbursement calls from `vault` are allowed.
     */
    function setAuthorizedVault(address vault, bool allowed) external onlyOwner {
        if (vault == address(0) || vault.code.length == 0) revert InvalidParam();
        _authorizedVaults[vault] = allowed;
        emit AuthorizedVaultUpdated(vault, allowed);
    }

    /**
     * @notice Sets reimbursement policy for one `(strategy, token)` pair.
     * @param strategy Strategy allowed to request reimbursement.
     * @param token Principal token to reimburse.
     * @param enabled Whether reimbursement is enabled for this pair.
     * @param remainingBudget Remaining exact-token budget reserved for this pair.
     */
    function setReimbursementConfig(
        address strategy,
        address token,
        bool enabled,
        uint256 remainingBudget
    ) external onlyOwner {
        if (strategy == address(0) || strategy.code.length == 0 || token == address(0)) revert InvalidParam();
        _reimbursementConfigs[strategy][token] = ReimbursementConfig({
            enabled: enabled,
            remainingBudget: remainingBudget
        });
        emit ReimbursementConfigUpdated(strategy, token, enabled, remainingBudget);
    }

    /**
     * @inheritdoc IWithdrawalFeeTreasury
     * @dev Exact-or-zero reimbursement keyed by `(msg.sender, token)`.
     */
    function reimburseWithdrawalFee(
        address token,
        address strategy,
        address recipient,
        uint256 amount
    ) external override nonReentrant returns (uint256 reimbursed) {
        if (token == address(0) || strategy == address(0) || recipient == address(0) || amount == 0)
            revert InvalidParam();
        if (!_authorizedVaults[msg.sender]) return 0;

        ReimbursementConfig storage config = _reimbursementConfigs[strategy][token];
        if (!config.enabled || config.remainingBudget < amount) return 0;
        if (IERC20(token).balanceOf(address(this)) < amount) return 0;

        config.remainingBudget -= amount;
        IERC20(token).safeTransfer(recipient, amount);
        emit WithdrawalFeeReimbursed(strategy, token, recipient, amount, config.remainingBudget);
        return amount;
    }

    /**
     * @notice Sweeps ERC20 balance out of the treasury.
     * @param token ERC20 token to withdraw.
     * @param recipient Recipient of the withdrawn balance.
     * @param amount Amount to withdraw.
     */
    function withdrawERC20(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || recipient == address(0) || amount == 0) revert InvalidParam();

        IERC20(token).safeTransfer(recipient, amount);
        emit ERC20Withdrawn(token, recipient, amount);
    }

    /**
     * @notice Sweeps native ETH balance out of the treasury.
     * @param recipient Recipient of the withdrawn ETH.
     * @param amount Amount of ETH to withdraw.
     */
    function withdrawNative(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || amount == 0 || amount > address(this).balance) revert InvalidParam();

        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeWithdrawn(recipient, amount);
    }

    /// @notice Accepts native ETH from vault harvests and native sweep flows.
    receive() external payable {}
}
