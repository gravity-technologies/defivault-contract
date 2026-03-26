// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";

/**
 * @title NativeVaultGateway
 * @notice External native-asset entrypoint that wraps ETH and forwards wrapped-native tokens to the vault.
 * @dev Why this exists:
 *      - The vault's accounting model is ERC20-only; native exposure is modeled as wrapped-native internally.
 *      - The vault intentionally rejects arbitrary ETH sends, so external native inflow must be normalized before it
 *        reaches vault custody.
 *      - This contract stays intentionally stateless in normal flow and should not retain persistent ETH or
 *        wrapped-native.
 *      - If unexpected ETH or ERC20 balances are stranded here, vault admins can recover them through the
 *        explicit rescue methods below.
 */
contract NativeVaultGateway {
    using SafeERC20 for IERC20;

    error InvalidParam();
    error NativeDepositRequiresFullGas();
    error Unauthorized();

    uint256 private constant RECEIVE_GAS_STIPEND = 2300;

    /// @notice Wrapped-native token used by vault accounting.
    address public immutable wrappedNativeToken;

    /// @notice L1 vault recipient that receives wrapped-native tokens.
    address public immutable vault;

    /// @notice Emitted when native ETH is wrapped and forwarded to the vault.
    /// @param sender External caller that provided native ETH.
    /// @param amount Native ETH amount wrapped and forwarded.
    event NativeDepositedToVault(address indexed sender, uint256 amount);
    /// @notice Emitted when unexpected native ETH held by the gateway is recovered.
    /// @param caller Account that triggered the rescue sweep.
    /// @param recipient Address that received the rescued ETH.
    /// @param amount Native ETH amount forwarded.
    event UnexpectedNativeSwept(address indexed caller, address indexed recipient, uint256 amount);
    /// @notice Emitted when an unexpected ERC20 balance is recovered.
    /// @param caller Account that triggered the rescue sweep.
    /// @param token ERC20 token recovered.
    /// @param recipient Address that received the rescued tokens.
    /// @param amount Token amount forwarded.
    event UnexpectedTokenSwept(
        address indexed caller,
        address indexed token,
        address indexed recipient,
        uint256 amount
    );

    /**
     * @param wrappedNativeToken_ Wrapped-native token contract address.
     * @param vault_ Vault recipient address.
     */
    constructor(address wrappedNativeToken_, address vault_) {
        if (wrappedNativeToken_ == address(0) || vault_ == address(0)) revert InvalidParam();
        if (wrappedNativeToken_.code.length == 0 || vault_.code.length == 0) revert InvalidParam();
        wrappedNativeToken = wrappedNativeToken_;
        vault = vault_;
    }

    /**
     * @notice Wraps `msg.value` ETH and forwards wrapped-native tokens to the vault.
     * @dev Reverts on zero-value sends.
     */
    function depositToVault() external payable {
        _depositToVault(msg.sender, msg.value);
    }

    /**
     * @notice Recovers unexpected native ETH held by the gateway to `recipient`.
     * @dev This is a break-glass path for forced ETH or accidental native transfers that were not attached
     *      to a normal deposit call. Only vault admins may call it.
     *
     *      Reverts on zero address recipient, zero amount, or insufficient native balance.
     * @param recipient Address that should receive the rescued ETH.
     * @param amount Native ETH amount to recover.
     */
    function sweepNative(address recipient, uint256 amount) external onlyVaultAdmin {
        if (recipient == address(0) || amount == 0 || amount > address(this).balance) revert InvalidParam();

        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert InvalidParam();

        emit UnexpectedNativeSwept(msg.sender, recipient, amount);
    }

    /**
     * @notice Recovers an unexpected ERC20 balance held by the gateway to `recipient`.
     * @dev This is a break-glass path for accidental direct token transfers. Only vault admins may call it.
     *      Reverts on invalid token/recipient input, zero amount, or insufficient balance.
     * @param token ERC20 token to recover.
     * @param recipient Address that should receive the rescued tokens.
     * @param amount Token amount to recover.
     */
    function sweepToken(address token, address recipient, uint256 amount) external onlyVaultAdmin {
        if (token == address(0) || recipient == address(0) || token.code.length == 0 || amount == 0) {
            revert InvalidParam();
        }

        if (IERC20(token).balanceOf(address(this)) < amount) revert InvalidParam();

        IERC20(token).safeTransfer(recipient, amount);

        emit UnexpectedTokenSwept(msg.sender, token, recipient, amount);
    }

    /**
     * @notice Convenience receive path for plain ETH transfers.
     * @dev Requires more than Solidity's `transfer`/`send` stipend because the gateway immediately
     *      wraps ETH and transfers wrapped-native into the vault. Integrations should use
     *      `depositToVault()` or a full-gas native `call`, not stipend-based sends.
     */
    receive() external payable {
        if (gasleft() <= RECEIVE_GAS_STIPEND) revert NativeDepositRequiresFullGas();
        _depositToVault(msg.sender, msg.value);
    }

    /**
     * @notice Rejects calldata-bearing sends.
     */
    fallback() external payable {
        revert InvalidParam();
    }

    /**
     * @notice Internal wrap-and-forward implementation.
     * @param sender External sender used for telemetry.
     * @param amount Native ETH amount to wrap.
     */
    function _depositToVault(address sender, uint256 amount) internal {
        if (amount == 0) revert InvalidParam();

        IWrappedNative(wrappedNativeToken).deposit{value: amount}();
        IERC20(wrappedNativeToken).safeTransfer(vault, amount);

        emit NativeDepositedToVault(sender, amount);
    }

    /**
     * @notice Restricts rescue paths to current vault admins.
     */
    modifier onlyVaultAdmin() {
        IL1TreasuryVault vault_ = IL1TreasuryVault(vault);
        if (!vault_.hasRole(vault_.VAULT_ADMIN_ROLE(), msg.sender)) revert Unauthorized();
        _;
    }
}
