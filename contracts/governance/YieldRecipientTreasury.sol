// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";

/**
 * @title YieldRecipientTreasury
 * @notice Treasury sink for harvested yield and same-token fee reimbursements.
 * @dev This contract is designed to be set as the vault's `yieldRecipient`.
 */
contract YieldRecipientTreasury is Ownable2Step, ReentrancyGuard, IFeeReimburser {
    using SafeERC20 for IERC20;

    /// @dev Input address or amount is zero or otherwise malformed.
    error InvalidParam();
    /// @dev Caller is not an authorized vault.
    error UnauthorizedVault();
    /// @dev Treasury does not currently hold enough of the token to satisfy the reimbursement.
    error InsufficientTreasuryBalance();
    /// @dev Native ETH transfer failed.
    error NativeTransferFailed();

    /// @dev Vaults allowed to pull reimbursement from this treasury.
    mapping(address vault => bool allowed) private _authorizedVaults;

    /// @notice Emitted when vault authorization changes.
    event AuthorizedVaultUpdated(address indexed vault, bool allowed);

    /// @notice Emitted when a reimbursement is paid.
    event FeeReimbursed(address indexed token, address recipient, uint256 amount);

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

    /// @inheritdoc IFeeReimburser
    function isFeeReimburser() external pure override returns (bytes4 selector) {
        return IFeeReimburser.isFeeReimburser.selector;
    }

    /// @inheritdoc IFeeReimburser
    function isAuthorizedVault(address vault) external view override returns (bool allowed) {
        if (vault == address(0)) revert InvalidParam();
        return _authorizedVaults[vault];
    }

    /**
     * @notice Sets whether `vault` may call reimbursement methods.
     * @param vault Vault caller to authorize or revoke.
     * @param allowed Whether reimbursement calls from `vault` are allowed.
     */
    function setAuthorizedVault(address vault, bool allowed) external onlyOwner {
        if (vault == address(0) || vault.code.length == 0) revert InvalidParam();
        _authorizedVaults[vault] = allowed;
        emit AuthorizedVaultUpdated(vault, allowed);
    }

    /// @inheritdoc IFeeReimburser
    function reimburseFee(
        address token,
        address recipient,
        uint256 amount
    ) public override nonReentrant returns (uint256 reimbursed) {
        if (token == address(0) || recipient == address(0) || amount == 0) {
            revert InvalidParam();
        }
        if (!_authorizedVaults[msg.sender]) revert UnauthorizedVault();

        if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientTreasuryBalance();

        IERC20(token).safeTransfer(recipient, amount);
        emit FeeReimbursed(token, recipient, amount);
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
