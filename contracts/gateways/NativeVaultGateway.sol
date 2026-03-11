// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";

/**
 * @title NativeVaultGateway
 * @notice External native-asset entrypoint that wraps ETH and forwards wrapped-native tokens to the vault.
 * @dev Why this exists:
 *      - The vault's accounting model is ERC20-only; native exposure is modeled as wrapped-native internally.
 *      - The vault intentionally rejects arbitrary ETH sends, so external native inflow must be normalized before it
 *        reaches vault custody.
 *      - This contract stays intentionally stateless in normal flow and should not retain persistent ETH or
 *        wrapped-native.
 */
contract NativeVaultGateway {
    using SafeERC20 for IERC20;

    error InvalidParam();

    /// @notice Wrapped-native token used by vault accounting.
    address public immutable wrappedNativeToken;

    /// @notice L1 vault recipient that receives wrapped-native tokens.
    address public immutable vault;

    /// @notice Emitted when native ETH is wrapped and forwarded to the vault.
    /// @param sender External caller that provided native ETH.
    /// @param amount Native ETH amount wrapped and forwarded.
    event NativeDepositedToVault(address indexed sender, uint256 amount);

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
     * @notice Convenience receive path for plain ETH transfers.
     */
    receive() external payable {
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
}
