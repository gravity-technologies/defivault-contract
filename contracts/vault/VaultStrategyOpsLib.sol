// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {StrategyAssetBreakdown} from "../interfaces/IVaultReportingTypes.sol";

library VaultStrategyOpsLib {
    using SafeERC20 for IERC20;

    /**
     * @notice Withdraws strategy funds and measures the vault-side balance delta as the authoritative result.
     * @param token Principal token being withdrawn.
     * @param strategy Strategy to call.
     * @param requested Requested withdrawal amount.
     * @param useAll True to call `deallocateAll`, false to call bounded `deallocate`.
     * @return reported Amount self-reported by the strategy.
     * @return received Amount actually measured back at the vault.
     */
    function deallocateWithBalanceDelta(
        address token,
        address strategy,
        uint256 requested,
        bool useAll
    ) public returns (uint256 reported, uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        reported = useAll
            ? IYieldStrategy(strategy).deallocateAll(token)
            : IYieldStrategy(strategy).deallocate(token, requested);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert IL1TreasuryVault.InvalidParam();
        received = afterBal - beforeBal;
    }

    /**
     * @notice Pays harvested proceeds to the configured recipient and measures recipient-side receipt.
     * @dev Wrapped-native principal is unwrapped and sent as native ETH; all other assets are transferred as ERC20.
     * @param principalToken Principal token used for the harvest.
     * @param wrappedNativeToken Canonical wrapped-native token used for native payouts.
     * @param recipient Treasury/yield recipient.
     * @param amount Amount to forward.
     * @return received Amount actually observed at the recipient after transfer.
     */
    function payoutHarvestProceeds(
        address principalToken,
        address wrappedNativeToken,
        address recipient,
        uint256 amount
    ) public returns (uint256 received) {
        if (principalToken == wrappedNativeToken) {
            uint256 nativeRecipientBefore = recipient.balance;
            IWrappedNative(wrappedNativeToken).withdraw(amount);
            _sendNative(recipient, amount);
            uint256 nativeRecipientAfter = recipient.balance;
            if (nativeRecipientAfter < nativeRecipientBefore) revert IL1TreasuryVault.InvalidParam();
            return nativeRecipientAfter - nativeRecipientBefore;
        }

        IERC20 asset = IERC20(principalToken);
        uint256 erc20RecipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 erc20RecipientAfter = asset.balanceOf(recipient);
        if (erc20RecipientAfter < erc20RecipientBefore) revert IL1TreasuryVault.InvalidParam();
        return erc20RecipientAfter - erc20RecipientBefore;
    }

    /**
     * @notice Reads scalar principal-bearing exposure from a strategy with failure normalization.
     * @param token Principal token domain to query.
     * @param strategy Strategy to read.
     * @return ok True when the strategy call succeeded.
     * @return exposure Scalar exposure returned by the strategy when successful.
     */
    function readStrategyExposure(address token, address strategy) public view returns (bool ok, uint256 exposure) {
        try IYieldStrategy(strategy).principalBearingExposure(token) returns (uint256 value) {
            return (true, value);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Reads scalar principal-bearing exposure and reverts with the vault's canonical error on failure.
     * @param token Principal token domain to query.
     * @param strategy Strategy to read.
     * @return exposure Scalar exposure returned by the strategy.
     */
    function readStrategyExposureOrRevert(address token, address strategy) public view returns (uint256 exposure) {
        (bool ok, uint256 value) = readStrategyExposure(token, strategy);
        if (!ok) revert IL1TreasuryVault.InvalidStrategyExposureRead(token, strategy);
        return value;
    }

    /**
     * @notice Returns whether a token still has any idle or strategy-side principal exposure.
     * @dev Conservatively returns true on strategy exposure read failure to avoid under-tracking.
     * @param token Principal token to inspect.
     * @param strategies Active strategy list for the token domain.
     * @return True when idle balance exists, any strategy exposure exists, or a strategy read fails.
     */
    function hasAnyPrincipalExposure(address token, address[] memory strategies) public view returns (bool) {
        (bool ok, uint256 idle) = tryBalanceOf(token, address(this));
        if (ok && idle != 0) return true;

        for (uint256 i = 0; i < strategies.length; ++i) {
            (bool exposureOk, uint256 exposure) = readStrategyExposure(token, strategies[i]);
            if (!exposureOk || exposure != 0) return true;
        }
        return false;
    }

    /**
     * @notice Reads the exact-token balance reported by a strategy for one exact token query.
     * @dev Returns `(false, 0)` on strategy read failure.
     * @param token Exact token to aggregate.
     * @param strategy Strategy to query.
     * @return ok True when the read completed successfully.
     * @return amount Exact token balance returned by the strategy.
     */
    function readStrategyExactTokenBalance(
        address token,
        address strategy
    ) public view returns (bool ok, uint256 amount) {
        try IYieldStrategy(strategy).exactTokenBalance(token) returns (uint256 value) {
            return (true, value);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Reads the full strategy principal-domain breakdown and normalizes failure to the vault's custom error.
     * @param principalToken Principal token-domain query passed into the strategy.
     * @param strategy Strategy to query.
     * @return breakdown Full strategy asset breakdown.
     */
    function readStrategyPositionBreakdownOrRevert(
        address principalToken,
        address strategy
    ) public view returns (StrategyAssetBreakdown memory breakdown) {
        try IYieldStrategy(strategy).positionBreakdown(principalToken) returns (StrategyAssetBreakdown memory data) {
            return data;
        } catch {
            revert IL1TreasuryVault.InvalidStrategyAssetsRead(principalToken, strategy);
        }
    }

    /**
     * @notice Performs a defensive ERC20 `balanceOf` probe.
     * @dev Returns `(false, 0)` for malformed or reverting tokens instead of bubbling the failure.
     * @param token Token contract to probe.
     * @param account Account whose balance should be read.
     * @return ok True when the token returned at least one full word of data.
     * @return balance Decoded balance when `ok == true`.
     */
    function tryBalanceOf(address token, address account) public view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (!success || data.length < 32) {
            return (false, 0);
        }
        return (true, abi.decode(data, (uint256)));
    }

    /**
     * @notice Sends native ETH and normalizes failure to the vault's custom error surface.
     * @param recipient Native recipient.
     * @param amount Native amount to transfer.
     */
    function _sendNative(address recipient, uint256 amount) private {
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert IL1TreasuryVault.NativeTransferFailed();
    }
}
