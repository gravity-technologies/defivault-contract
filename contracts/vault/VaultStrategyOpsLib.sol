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

/**
 * @title VaultStrategyOpsLib
 * @notice Stateless library for strategy read helpers, fee math, and payout mechanics.
 * @dev The heavy V2 orchestration (balance-delta measurement, fee inference, reimbursement)
 *      is now inline in the OpsModule. This library retains read helpers, fee math, and legacy
 *      deallocation wrappers used by both the OpsModule and ViewModule.
 */
library VaultStrategyOpsLib {
    using SafeERC20 for IERC20;

    // --------- V2 marker ---------

    /**
     * @notice Returns true when `strategy` implements the V2 strategy surface.
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
     * @notice Returns true when the V2 strategy lane token matches `token`.
     */
    function v2VaultTokenMatches(address token, address strategy) public view returns (bool) {
        return _v2VaultTokenMatches(token, strategy);
    }

    // --------- Fee math ---------

    /**
     * @notice Returns the maximum fee allowed by one fee basis and bps cap.
     */
    function feeCapAmount(uint256 feeBasis, uint16 capBps) public pure returns (uint256 cap) {
        return (feeBasis * capBps) / 10_000;
    }

    // --------- Legacy deallocation ---------

    /**
     * @notice Withdraws legacy strategy funds and measures the vault-side balance delta.
     */
    function deallocateLegacyWithBalanceDelta(
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

    // --------- Reimbursement ---------

    /**
     * @notice Requests fee reimbursement from treasury and measures the vault-side receipt.
     */
    function reimburseFee(
        address token,
        address treasury,
        address strategy,
        uint256 amount
    ) public returns (uint256 reported, uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        reported = IWithdrawalFeeTreasury(treasury).reimburseFee(token, strategy, address(this), amount);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert IL1TreasuryVault.InvalidParam();
        received = afterBal - beforeBal;
    }

    // --------- Strategy read helpers ---------

    /**
     * @notice Reads strategy exposure from a strategy with failure normalization.
     * @dev V2 strategies call `totalExposure()`. Legacy strategies call `strategyExposure(token)`.
     */
    function readStrategyExposure(address token, address strategy) public view returns (bool ok, uint256 exposure) {
        if (isYieldStrategyV2(strategy)) {
            if (!_v2VaultTokenMatches(token, strategy)) return (false, 0);
            try IYieldStrategyV2(strategy).totalExposure() returns (uint256 value) {
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
     */
    function readStrategyExposureOrRevert(address token, address strategy) public view returns (uint256 exposure) {
        (bool ok, uint256 value) = readStrategyExposure(token, strategy);
        if (!ok) revert IL1TreasuryVault.InvalidStrategyExposureRead(token, strategy);
        return value;
    }

    /**
     * @notice Reads the exact-token balance reported by a strategy for one exact token query.
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

    // --------- Treasury compatibility ---------

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

    // --------- Harvest payout ---------

    /**
     * @notice Pays harvested proceeds to the configured recipient and normalizes receipt accounting.
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
     * @notice Returns raw harvestable value for one strategy lane.
     * @dev Unified for V2 and legacy: `max(0, exposure - costBasis)`.
     */
    function rawHarvestableYield(address token, address strategy, uint256 costBasis) public view returns (uint256) {
        uint256 exposure = readStrategyExposureOrRevert(token, strategy);
        if (exposure <= costBasis) return 0;
        return exposure - costBasis;
    }

    // --------- Utilities ---------

    /**
     * @notice Performs a defensive ERC20 `balanceOf` probe.
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
     */
    function _sendNative(address recipient, uint256 amount) private {
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert IL1TreasuryVault.NativeTransferFailed();
    }

    /// @notice Returns whether a V2 strategy reports `token` as its bound lane token.
    function _v2VaultTokenMatches(address token, address strategy) private view returns (bool) {
        try IYieldStrategyV2(strategy).vaultToken() returns (address laneToken) {
            return laneToken == token;
        } catch {
            return false;
        }
    }

    /// @notice Reverts unless a V2 strategy lane is bound to `token`.
    function _requireV2VaultToken(address token, address strategy) private view {
        if (!_v2VaultTokenMatches(token, strategy)) revert IL1TreasuryVault.InvalidParam();
    }
}
