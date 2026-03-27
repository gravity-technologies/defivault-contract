// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {IWithdrawalFeeTreasury} from "../interfaces/IWithdrawalFeeTreasury.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {PositionComponent} from "../interfaces/IVaultReportingTypes.sol";

library VaultStrategyOpsLib {
    using SafeERC20 for IERC20;

    uint256 private constant MAX_REIMBURSEMENT_BPS = 20;

    struct StrategyDeallocationResult {
        uint256 reported;
        uint256 trackedReceived;
        uint256 residualReceived;
        uint256 reportedFee;
        uint256 trackedRequested;
    }

    /**
     * @notice Returns true when `strategy` implements the V2 tracked/residual surface.
     * @dev Unsupported strategies and marker failures are normalized to `false`.
     */
    function isYieldStrategyV2(address strategy) public pure returns (bool) {
        try IYieldStrategyV2(strategy).isYieldStrategyV2() returns (bytes4 selector) {
            return selector == IYieldStrategyV2.isYieldStrategyV2.selector;
        } catch {
            return false;
        }
    }

    /**
     * @notice Allocates strategy funds and measures net vault-side token spend as the authoritative result.
     * @dev `spent` is the vault's net balance decrease across the external `allocate` call. Same-call
     *      inbound transfers back to the vault reduce `spent`. Invalid balance shapes revert.
     * @param token Vault token being allocated.
     * @param strategy Strategy to call.
     * @param requested Requested allocation amount.
     * @return spent Net vault-side token balance decrease observed during allocation.
     */
    function allocateWithBalanceDelta(
        address token,
        address strategy,
        uint256 requested
    ) public returns (uint256 spent) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        if (isYieldStrategyV2(strategy)) {
            _requireV2VaultToken(token, strategy);
            IYieldStrategyV2(strategy).allocate(requested);
        } else {
            IYieldStrategy(strategy).allocate(token, requested);
        }
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal > beforeBal) {
            revert IL1TreasuryVault.InvalidAllocationBalanceDelta(token, strategy, requested, beforeBal, afterBal);
        }
        spent = beforeBal - afterBal;
        if (spent > requested) {
            revert IL1TreasuryVault.InvalidAllocationBalanceDelta(token, strategy, requested, beforeBal, afterBal);
        }
    }

    /**
     * @notice Withdraws strategy funds and measures the vault-side balance delta as the authoritative result.
     * @param token Vault token being withdrawn.
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
     * @notice Withdraws tracked strategy value and measures the vault-side balance delta as the authoritative result.
     * @param token Vault token being withdrawn.
     * @param strategy Strategy to call.
     * @param requested Requested tracked withdrawal amount.
     * @return reported Amount self-reported by the strategy.
     * @return reimbursableFee Exact reimbursement amount self-reported by the strategy.
     * @return received Amount actually measured back at the vault.
     */
    function withdrawTrackedWithBalanceDelta(
        address token,
        address strategy,
        uint256 requested
    ) public returns (uint256 reported, uint256 reimbursableFee, uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        _requireV2VaultToken(token, strategy);
        (reported, reimbursableFee) = IYieldStrategyV2(strategy).withdrawTracked(requested);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert IL1TreasuryVault.InvalidParam();
        received = afterBal - beforeBal;
    }

    /**
     * @notice Realizes strategy residual value and measures the vault-side balance delta as the authoritative result.
     * @param token Vault token being withdrawn.
     * @param strategy Strategy to call.
     * @param requested Requested residual withdrawal amount.
     * @return reported Amount self-reported by the strategy.
     * @return received Amount actually measured back at the vault.
     */
    function withdrawResidualWithBalanceDelta(
        address token,
        address strategy,
        uint256 requested
    ) public returns (uint256 reported, uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        _requireV2VaultToken(token, strategy);
        reported = IYieldStrategyV2(strategy).withdrawResidual(requested);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert IL1TreasuryVault.InvalidParam();
        received = afterBal - beforeBal;
    }

    /**
     * @notice Realizes all strategy residual value and measures the vault-side balance delta as the authoritative result.
     * @param token Vault token being withdrawn.
     * @param strategy Strategy to call.
     * @return reported Amount self-reported by the strategy.
     * @return received Amount actually measured back at the vault.
     */
    function withdrawAllResidualWithBalanceDelta(
        address token,
        address strategy
    ) public returns (uint256 reported, uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        _requireV2VaultToken(token, strategy);
        reported = IYieldStrategyV2(strategy).withdrawAllResidual();
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert IL1TreasuryVault.InvalidParam();
        received = afterBal - beforeBal;
    }

    /**
     * @notice Requests withdrawal-fee reimbursement from treasury and measures the vault-side receipt.
     * @param token ERC20 token to reimburse.
     * @param treasury Treasury source contract.
     * @param amount Exact reimbursement amount requested.
     * @return reported Amount self-reported by treasury.
     * @return received Amount actually measured at the vault.
     */
    function reimburseWithdrawalFee(
        address token,
        address treasury,
        address strategy,
        uint256 amount
    ) public returns (uint256 reported, uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        reported = IWithdrawalFeeTreasury(treasury).reimburseWithdrawalFee(token, strategy, address(this), amount);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert IL1TreasuryVault.InvalidParam();
        received = afterBal - beforeBal;
    }

    /**
     * @notice Caps reimbursable withdrawal fee by the remaining tracked gap and the lane's hard bps ceiling.
     * @dev This prevents treasury reimbursement once strategy-path receipts already restore the full tracked amount
     *      for the current exit, including cases where excess yield or residual balances absorb the fee.
     * @param trackedRequested Tracked amount requested through the reimbursing path.
     * @param trackedReceived Tracked-leg receipt measured at the vault for this exit.
     * @param reportedFee Exact fee self-reported by the strategy.
     * @return reimbursable Fee amount still eligible for treasury reimbursement.
     */
    function cappedReimbursement(
        uint256 trackedRequested,
        uint256 trackedReceived,
        uint256 reportedFee
    ) public pure returns (uint256 reimbursable) {
        if (trackedRequested == 0 || reportedFee == 0) return 0;

        uint256 trackedGap = trackedRequested > trackedReceived ? trackedRequested - trackedReceived : 0;
        if (trackedGap == 0) return 0;

        reimbursable = reportedFee;
        if (reimbursable > trackedGap) reimbursable = trackedGap;

        uint256 bpsCap = maxReimbursementCap(trackedRequested);
        if (reimbursable > bpsCap) reimbursable = bpsCap;
    }

    /**
     * @notice Returns the hard reimbursement ceiling for a tracked leg.
     * @param trackedRequested Tracked amount requested through the reimbursing path.
     * @return cap Maximum reimbursable fee for the requested tracked leg.
     */
    function maxReimbursementCap(uint256 trackedRequested) public pure returns (uint256 cap) {
        return (trackedRequested * MAX_REIMBURSEMENT_BPS) / 10_000;
    }

    /**
     * @notice Executes a strategy deallocation using the reimbursing tracked leg when supported.
     * @dev The tracked leg is capped at the current tracked amount still outstanding. Any residual request
     *      is satisfied through the plain non-reimbursing deallocation path.
     */
    function executeStrategyDeallocation(
        address token,
        address strategy,
        uint256 requested,
        bool useAll,
        uint256 trackedOutstanding
    ) public returns (StrategyDeallocationResult memory result) {
        if (!isYieldStrategyV2(strategy)) {
            (result.reported, result.trackedReceived) = deallocateWithBalanceDelta(token, strategy, requested, useAll);
            return result;
        }

        uint256 trackedRequest = useAll
            ? trackedOutstanding
            : (requested < trackedOutstanding ? requested : trackedOutstanding);
        result.trackedRequested = trackedRequest;
        if (trackedRequest != 0) {
            (
                uint256 trackedReported,
                uint256 reimbursableFee,
                uint256 trackedReceived
            ) = withdrawTrackedWithBalanceDelta(token, strategy, trackedRequest);
            result.reported += trackedReported;
            result.reportedFee = reimbursableFee;
            result.trackedReceived = trackedReceived;
        }

        if (useAll) {
            (uint256 residualReported, uint256 residualReceived) = withdrawAllResidualWithBalanceDelta(token, strategy);
            result.reported += residualReported;
            result.residualReceived = residualReceived;
            return result;
        }

        if (requested > trackedRequest) {
            uint256 residualRequested = requested - trackedRequest;
            (uint256 residualReported, uint256 residualReceived) = withdrawResidualWithBalanceDelta(
                token,
                strategy,
                residualRequested
            );
            result.reported += residualReported;
            result.residualReceived = residualReceived;
        }
    }

    /**
     * @notice Executes a residual-only deallocation path when the strategy supports explicit residual exits.
     * @dev Falls back to the base `IYieldStrategy` deallocation semantics for non-reimbursing strategies.
     */
    function executeResidualDeallocation(
        address token,
        address strategy,
        uint256 requested,
        bool useAll
    ) public returns (uint256 reported, uint256 received) {
        if (!isYieldStrategyV2(strategy)) {
            return deallocateWithBalanceDelta(token, strategy, requested, useAll);
        }

        return
            useAll
                ? withdrawAllResidualWithBalanceDelta(token, strategy)
                : withdrawResidualWithBalanceDelta(token, strategy, requested);
    }

    /**
     * @notice Reads residual-only strategy exposure from a reimbursement-capable strategy.
     * @dev Failures are normalized to the vault's standard strategy-exposure error surface.
     * @param token Vault token lane to query.
     * @param strategy Strategy to read.
     * @return exposure Residual value currently realizable in `token` units.
     */
    function readResidualExposureOrRevert(address token, address strategy) public view returns (uint256 exposure) {
        _requireV2VaultToken(token, strategy);
        try IYieldStrategyV2(strategy).residualExposure() returns (uint256 value) {
            return value;
        } catch {
            revert IL1TreasuryVault.InvalidStrategyExposureRead(token, strategy);
        }
    }

    /**
     * @notice Returns true when `treasury` implements the withdrawal-fee treasury marker interface.
     */
    function isCompatibleWithdrawalFeeTreasury(address treasury) public view returns (bool) {
        if (treasury == address(0) || treasury.code.length == 0) return false;
        try IWithdrawalFeeTreasury(treasury).isWithdrawalFeeTreasury() returns (bytes4 selector) {
            return selector == IWithdrawalFeeTreasury.isWithdrawalFeeTreasury.selector;
        } catch {
            return false;
        }
    }

    /**
     * @notice Pays harvested proceeds to the configured recipient and normalizes receipt accounting.
     * @dev Wrapped-native vault token is unwrapped and sent as native ETH; all other tokens are transferred as ERC20.
     *      Successful native payout is treated as `amount` received because the recipient may
     *      forward or redistribute ETH during the same call and retained balance is not a reliable
     *      receipt metric.
     * @param vaultToken Vault token used for the harvest.
     * @param wrappedNativeToken Canonical wrapped-native token used for native payouts.
     * @param recipient Treasury/yield recipient.
     * @param amount Amount to forward.
     * @return received Amount actually counted as received by the recipient logic.
     */
    function payoutHarvestProceeds(
        address vaultToken,
        address wrappedNativeToken,
        address recipient,
        uint256 amount
    ) public returns (uint256 received) {
        if (vaultToken == wrappedNativeToken) {
            IWrappedNative(wrappedNativeToken).withdraw(amount);
            _sendNative(recipient, amount);
            return amount;
        }

        IERC20 asset = IERC20(vaultToken);
        uint256 erc20RecipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 erc20RecipientAfter = asset.balanceOf(recipient);
        if (erc20RecipientAfter < erc20RecipientBefore) revert IL1TreasuryVault.InvalidParam();
        return erc20RecipientAfter - erc20RecipientBefore;
    }

    /**
     * @notice Reads strategy exposure from a strategy with failure normalization.
     * @param token Vault token to query.
     * @param strategy Strategy to read.
     * @return ok True when the strategy call succeeded.
     * @return exposure Scalar exposure returned by the strategy when successful.
     */
    function readStrategyExposure(address token, address strategy) public view returns (bool ok, uint256 exposure) {
        if (isYieldStrategyV2(strategy)) {
            if (!_v2VaultTokenMatches(token, strategy)) return (false, 0);
            try IYieldStrategyV2(strategy).strategyExposure() returns (uint256 value) {
                return (true, value);
            } catch {
                return (false, 0);
            }
        }
        try IYieldStrategy(strategy).strategyExposure(token) returns (uint256 value) {
            return (true, value);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Reads strategy exposure and reverts with the vault's standard error on failure.
     * @param token Vault token to query.
     * @param strategy Strategy to read.
     * @return exposure Scalar exposure returned by the strategy.
     */
    function readStrategyExposureOrRevert(address token, address strategy) public view returns (uint256 exposure) {
        (bool ok, uint256 value) = readStrategyExposure(token, strategy);
        if (!ok) revert IL1TreasuryVault.InvalidStrategyExposureRead(token, strategy);
        return value;
    }

    /**
     * @notice Returns whether a token still has any idle or strategy-side accounting exposure.
     * @dev Conservatively returns true on strategy exposure read failure to avoid under-tracking.
     * @param token Vault token to inspect.
     * @param strategies Active strategy list for the vault token.
     * @return True when idle balance exists, any strategy exposure exists, or a strategy read fails.
     */
    function hasAnyAccountingExposure(address token, address[] memory strategies) public view returns (bool) {
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
        if (isYieldStrategyV2(strategy)) {
            try IYieldStrategyV2(strategy).exactTokenBalance(token) returns (uint256 value) {
                return (true, value);
            } catch {
                return (false, 0);
            }
        }
        try IYieldStrategy(strategy).exactTokenBalance(token) returns (uint256 value) {
            return (true, value);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Reads the declared TVL-token list from a strategy for a given lane.
     * @dev V2 strategies are single-lane and must report for their configured `vaultToken`.
     *      Returns `(false, empty)` on strategy read failure.
     */
    function readStrategyTvlTokens(
        address vaultToken,
        address strategy
    ) public view returns (bool ok, address[] memory tokens) {
        if (isYieldStrategyV2(strategy)) {
            if (!_v2VaultTokenMatches(vaultToken, strategy)) return (false, tokens);
            try IYieldStrategyV2(strategy).tvlTokens() returns (address[] memory data) {
                return (true, data);
            } catch {
                return (false, tokens);
            }
        }
        try IYieldStrategy(strategy).tvlTokens(vaultToken) returns (address[] memory data) {
            return (true, data);
        } catch {
            return (false, tokens);
        }
    }

    /**
     * @notice Reads the full strategy position breakdown and normalizes failure to the vault's custom error.
     * @param vaultToken Vault-token query passed into the strategy.
     * @param strategy Strategy to query.
     * @return components Full strategy position component array.
     */
    function readStrategyPositionBreakdownOrRevert(
        address vaultToken,
        address strategy
    ) public view returns (PositionComponent[] memory components) {
        if (isYieldStrategyV2(strategy)) {
            _requireV2VaultToken(vaultToken, strategy);
            try IYieldStrategyV2(strategy).positionBreakdown() returns (PositionComponent[] memory data) {
                return data;
            } catch {
                revert IL1TreasuryVault.InvalidStrategyTokenRead(vaultToken, strategy);
            }
        }
        try IYieldStrategy(strategy).positionBreakdown(vaultToken) returns (PositionComponent[] memory data) {
            return data;
        } catch {
            revert IL1TreasuryVault.InvalidStrategyTokenRead(vaultToken, strategy);
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

    function _v2VaultTokenMatches(address token, address strategy) private view returns (bool) {
        try IYieldStrategyV2(strategy).vaultToken() returns (address laneToken) {
            return laneToken == token;
        } catch {
            return false;
        }
    }

    function _requireV2VaultToken(address token, address strategy) private view {
        if (!_v2VaultTokenMatches(token, strategy)) revert IL1TreasuryVault.InvalidParam();
    }
}
