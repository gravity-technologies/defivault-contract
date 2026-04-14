// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {IFeeReimburser} from "../interfaces/IFeeReimburser.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {VaultStrategyOpsLib} from "./VaultStrategyOpsLib.sol";
import {GRVTL1TreasuryVaultStorage} from "./GRVTL1TreasuryVaultStorage.sol";

/**
 * @title GRVTL1TreasuryVaultOpsModule
 * @notice Delegatecall module for heavy vault mutation paths.
 * @dev Executes in the vault storage context through delegatecall.
 * The vault wrappers are responsible for role checks, pause checks, and post-call TVL sync.
 *
 * V2 accounting model:
 * - Strategies are stateless. The vault owns all cost-basis accounting.
 * - `costBasis += invested` on allocate (net deployed value, not gross spend).
 * - Fee = amount - received (inferred from delta). Reimbursed unconditionally on tracked flows.
 * - Harvest is never reimbursed. Exit cap is enforced on all exit paths including harvest.
 * - Impairment is recognized at deallocateAll time: loss = costBasis - min(costBasis, exposure).
 */
contract GRVTL1TreasuryVaultOpsModule is GRVTL1TreasuryVaultStorage {
    using SafeERC20 for IERC20;

    /// @notice Emitted when one strategy lane policy config is created or updated.
    event StrategyPolicyConfigUpdated(
        address indexed vaultToken,
        address indexed strategy,
        uint24 entryCapHundredthBps,
        uint24 exitCapHundredthBps,
        bool policyActive
    );

    /// @notice Emitted after a strategy deallocation finishes.
    event VaultTokenDeallocatedFromStrategy(
        address indexed vaultToken,
        address indexed strategy,
        uint256 requested,
        uint256 received,
        uint256 fee,
        uint256 loss
    );

    /// @notice Emitted when a strategy-reported amount differs from the measured vault-side receipt.
    event StrategyReportedReceivedMismatch(
        address indexed vaultToken,
        address indexed strategy,
        uint256 reported,
        uint256 measured
    );

    /// @notice Emitted after a strategy allocation attempt completes.
    event VaultTokenAllocatedToStrategy(
        address indexed vaultToken,
        address indexed strategy,
        uint256 amount,
        uint256 invested,
        uint256 fee
    );

    /// @notice Emitted when harvested proceeds are paid out to the configured recipient.
    event YieldHarvested(
        address indexed vaultToken,
        address indexed strategy,
        address indexed recipient,
        uint256 requested,
        uint256 received
    );

    /**
     * @notice Sets or updates one strategy lane policy config.
     * @dev Validates the V2 marker, bound lane token, and any required treasury config.
     */
    function setStrategyPolicyConfig(
        address token,
        address strategy,
        IL1TreasuryVault.StrategyPolicyConfig calldata cfg
    ) external {
        VaultStrategyOpsLib.requireErc20Token(token);
        if (strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        if (
            cfg.entryCapHundredthBps > VaultStrategyOpsLib.HUNDREDTH_BPS_SCALE ||
            cfg.exitCapHundredthBps > VaultStrategyOpsLib.HUNDREDTH_BPS_SCALE
        ) revert IL1TreasuryVault.InvalidParam();

        if (
            !VaultStrategyOpsLib.isYieldStrategyV2(strategy) ||
            !VaultStrategyOpsLib.v2VaultTokenMatches(token, strategy)
        ) {
            revert IL1TreasuryVault.InvalidV2StrategyPolicy(token, strategy);
        }

        if (cfg.policyActive) {
            if (!_vaultTokenStrategyConfigs[token][strategy].active) {
                revert IL1TreasuryVault.InvalidV2StrategyPolicy(token, strategy);
            }
        }

        // Validate treasury is compatible if any cap > 0 (fees will be reimbursed unconditionally)
        if (cfg.entryCapHundredthBps > 0 || cfg.exitCapHundredthBps > 0) {
            _requireCompatibleTreasury(token, strategy);
        }

        _strategyPolicyConfigs[token][strategy] = cfg;
        if (!_hasStrategyPolicyConfig[token][strategy]) {
            _hasStrategyPolicyConfig[token][strategy] = true;
        }
        emit StrategyPolicyConfigUpdated(
            token,
            strategy,
            cfg.entryCapHundredthBps,
            cfg.exitCapHundredthBps,
            cfg.policyActive
        );
    }

    /**
     * @notice Allocates vault idle balance into one configured strategy lane.
     * @dev For V2: costBasis += invested, where `invested` is strategy-reported and only upper-bounded by
     *      measured vault-side spend. This is an intentional trust tradeoff for governance-controlled V2
     *      implementations. Fee = spent - invested. Reimbursed unconditionally.
     *      For legacy: costBasis += spent (measured delta, per 02-measured-vault-delta-cost-basis.md).
     */
    function allocateVaultTokenToStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external returns (uint256 spent) {
        VaultStrategyOpsLib.requireErc20Token(token);
        if (strategy == address(0) || amount == 0) revert IL1TreasuryVault.InvalidParam();
        if (!_vaultTokenConfigs[token].supported) revert IL1TreasuryVault.TokenNotSupported();

        IL1TreasuryVault.VaultTokenStrategyConfig storage sCfg = _vaultTokenStrategyConfigs[token][strategy];
        if (!sCfg.whitelisted) revert IL1TreasuryVault.StrategyNotWhitelisted();

        uint256 idle = VaultStrategyOpsLib.idleTokenBalance(token, address(this));
        if (idle < amount) revert IL1TreasuryVault.InvalidParam();

        IERC20(token).forceApprove(strategy, amount);

        if (VaultStrategyOpsLib.isYieldStrategyV2(strategy)) {
            IL1TreasuryVault.StrategyPolicyConfig memory policy = _requireActiveStrategyPolicy(token, strategy);

            uint256 balBefore = IERC20(token).balanceOf(address(this));
            uint256 invested = IYieldStrategyV2(strategy).allocate(amount);
            uint256 balAfter = IERC20(token).balanceOf(address(this));

            // Reconciliation guards: V2 still measures vault deltas, but only to reject
            // impossible shapes. It does not derive an independent lower bound on `invested`.
            if (balAfter > balBefore) {
                revert IL1TreasuryVault.InvalidAllocationBalanceDelta(token, strategy, amount, balBefore, balAfter);
            }
            spent = balBefore - balAfter;
            if (spent > amount) {
                revert IL1TreasuryVault.InvalidAllocationBalanceDelta(token, strategy, amount, balBefore, balAfter);
            }
            if (invested > spent) {
                revert IL1TreasuryVault.StrategyAccountingMismatch(token, strategy, invested, spent);
            }

            // Fee inference and cap check
            uint256 fee = spent - invested;
            if (fee > VaultStrategyOpsLib.feeCapAmount(spent, policy.entryCapHundredthBps)) {
                revert IL1TreasuryVault.FeeCapExceeded(
                    token,
                    strategy,
                    fee,
                    VaultStrategyOpsLib.feeCapAmount(spent, policy.entryCapHundredthBps)
                );
            }

            // Unconditional reimbursement on tracked flows
            if (fee > 0) {
                _reimburseFromTreasury(token, strategy, fee);
            }

            // Cap check uses invested for V2
            if (sCfg.cap != 0) {
                uint256 currentCostBasis = _strategyCostBasis[token][strategy];
                if (currentCostBasis > type(uint256).max - invested || currentCostBasis + invested > sCfg.cap) {
                    revert IL1TreasuryVault.CapExceeded();
                }
            }

            // costBasis += invested
            _strategyCostBasis[token][strategy] += invested;

            emit VaultTokenAllocatedToStrategy(token, strategy, amount, invested, fee);
        } else {
            // Legacy path: costBasis += spent (measured delta)
            if (sCfg.cap != 0) {
                uint256 current = VaultStrategyOpsLib.readStrategyExposureOrRevert(token, strategy);
                if (current > type(uint256).max - amount || current + amount > sCfg.cap) {
                    revert IL1TreasuryVault.CapExceeded();
                }
            }

            uint256 balBefore = IERC20(token).balanceOf(address(this));
            IYieldStrategy(strategy).allocate(token, amount);
            uint256 balAfter = IERC20(token).balanceOf(address(this));

            if (balAfter > balBefore) {
                revert IL1TreasuryVault.InvalidAllocationBalanceDelta(token, strategy, amount, balBefore, balAfter);
            }
            spent = balBefore - balAfter;
            if (spent > amount) {
                revert IL1TreasuryVault.InvalidAllocationBalanceDelta(token, strategy, amount, balBefore, balAfter);
            }

            _strategyCostBasis[token][strategy] += spent;
            emit VaultTokenAllocatedToStrategy(token, strategy, amount, spent, 0);
        }

        IERC20(token).forceApprove(strategy, 0);
    }

    /**
     * @notice Withdraws tracked principal from one strategy lane.
     * @dev V2: fee = amount - received, reimbursed unconditionally. costBasis -= amount.
     *      Legacy: costBasis -= received (measured delta).
     */
    function deallocateVaultTokenFromStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external returns (uint256 received) {
        VaultStrategyOpsLib.requireErc20Token(token);
        if (strategy == address(0) || amount == 0) revert IL1TreasuryVault.InvalidParam();
        if (!VaultStrategyOpsLib.canWithdrawVaultTokenFromStrategy(_vaultTokenStrategyConfigs[token][strategy])) {
            revert IL1TreasuryVault.StrategyNotWhitelisted();
        }

        if (VaultStrategyOpsLib.isYieldStrategyV2(strategy)) {
            uint256 costBasis = _strategyCostBasis[token][strategy];
            if (amount > costBasis) revert IL1TreasuryVault.InvalidParam();

            IL1TreasuryVault.StrategyPolicyConfig memory policy = _requireConfiguredStrategyPolicy(token, strategy);
            received = _withdrawPolicyStrategyWithBalanceDelta(token, strategy, amount);

            // Fee inference and cap check (also catches impairment)
            uint256 fee = amount - received;
            if (fee > VaultStrategyOpsLib.feeCapAmount(amount, policy.exitCapHundredthBps)) {
                revert IL1TreasuryVault.FeeCapExceeded(
                    token,
                    strategy,
                    fee,
                    VaultStrategyOpsLib.feeCapAmount(amount, policy.exitCapHundredthBps)
                );
            }

            // Unconditional reimbursement on tracked flows
            if (fee > 0) {
                _reimburseFromTreasury(token, strategy, fee);
            }

            _strategyCostBasis[token][strategy] = costBasis - amount;
            emit VaultTokenDeallocatedFromStrategy(token, strategy, amount, received, fee, 0);
        } else {
            // Legacy path
            (uint256 reported, uint256 measured) = VaultStrategyOpsLib.deallocateLegacyWithBalanceDelta(
                token,
                strategy,
                amount,
                false
            );
            received = measured;
            if (reported != measured) {
                emit StrategyReportedReceivedMismatch(token, strategy, reported, measured);
            }
            _decreaseStrategyCostBasis(token, strategy, received);
            emit VaultTokenDeallocatedFromStrategy(token, strategy, amount, received, 0, 0);
        }
    }

    /**
     * @notice Withdraws all tracked principal from one strategy lane, handling impairment.
     * @dev V2: economic recoverable value is `min(costBasis, totalExposure)`, but this path is fail-closed on
     *      operational illiquidity. If `withdrawableExposure` is below economically recoverable principal, the
     *      vault reverts and leaves `costBasis` unchanged for operational resolution.
     *      When liquidity is available, loss = costBasis - economicRecoverable and costBasis = 0.
     *      Legacy: deallocateAll + costBasis -= received.
     */
    function deallocateAllVaultTokenFromStrategy(address token, address strategy) external returns (uint256 received) {
        VaultStrategyOpsLib.requireErc20Token(token);
        if (strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        if (!VaultStrategyOpsLib.canWithdrawVaultTokenFromStrategy(_vaultTokenStrategyConfigs[token][strategy])) {
            revert IL1TreasuryVault.StrategyNotWhitelisted();
        }

        if (VaultStrategyOpsLib.isYieldStrategyV2(strategy)) {
            uint256 costBasis = _strategyCostBasis[token][strategy];
            if (costBasis == 0) return 0;

            IL1TreasuryVault.StrategyPolicyConfig memory policy = _requireConfiguredStrategyPolicy(token, strategy);
            uint256 economicExposure = VaultStrategyOpsLib.readStrategyExposureOrRevert(token, strategy);
            uint256 withdrawableExposure = VaultStrategyOpsLib.readStrategyWithdrawableExposureOrRevert(
                token,
                strategy
            );
            uint256 economicRecoverable = costBasis < economicExposure ? costBasis : economicExposure;
            uint256 withdrawable = costBasis < withdrawableExposure ? costBasis : withdrawableExposure;
            uint256 maxReimbursableFee = VaultStrategyOpsLib.feeCapAmount(
                economicRecoverable,
                policy.exitCapHundredthBps
            );
            if (withdrawable + maxReimbursableFee < economicRecoverable) {
                revert IL1TreasuryVault.InsufficientWithdrawableStrategyExposure(
                    token,
                    strategy,
                    economicRecoverable,
                    withdrawable + maxReimbursableFee
                );
            }
            uint256 loss = costBasis - economicRecoverable;

            uint256 fee;
            if (withdrawable > 0) {
                received = _withdrawPolicyStrategyWithBalanceDelta(token, strategy, withdrawable);
                fee = economicRecoverable - received;
                if (fee > maxReimbursableFee) {
                    revert IL1TreasuryVault.FeeCapExceeded(token, strategy, fee, maxReimbursableFee);
                }

                // Unconditional reimbursement on tracked flows
                if (fee > 0) {
                    _reimburseFromTreasury(token, strategy, fee);
                }
            }

            _strategyCostBasis[token][strategy] = 0;
            emit VaultTokenDeallocatedFromStrategy(token, strategy, type(uint256).max, received, fee, loss);
        } else {
            // Legacy path
            (uint256 reported, uint256 measured) = VaultStrategyOpsLib.deallocateLegacyWithBalanceDelta(
                token,
                strategy,
                0,
                true
            );
            received = measured;
            if (reported != measured) {
                emit StrategyReportedReceivedMismatch(token, strategy, reported, measured);
            }
            _decreaseStrategyCostBasis(token, strategy, received);
            emit VaultTokenDeallocatedFromStrategy(token, strategy, type(uint256).max, received, 0, 0);
        }
    }

    /**
     * @notice Realizes residual yield and pays it to the configured yield recipient.
     * @dev Harvest is never reimbursed — any exit fee is GRVT's cost. Exit cap is still enforced.
     *      When costBasis == 0, harvest is allowed even if policyActive is false (final residual sweep).
     */
    function harvestYieldFromStrategy(
        address token,
        address strategy,
        uint256 amount,
        uint256 minReceived
    ) external returns (uint256 received) {
        VaultStrategyOpsLib.requireErc20Token(token);
        if (strategy == address(0) || amount == 0) revert IL1TreasuryVault.InvalidParam();
        if (!VaultStrategyOpsLib.canWithdrawVaultTokenFromStrategy(_vaultTokenStrategyConfigs[token][strategy])) {
            revert IL1TreasuryVault.StrategyNotWhitelisted();
        }
        address recipient = _yieldRecipient;
        if (recipient == address(0)) revert IL1TreasuryVault.InvalidParam();

        if (VaultStrategyOpsLib.isYieldStrategyV2(strategy)) {
            uint256 withdrawnToVault = _executePolicyHarvest(token, strategy, amount);
            received = VaultStrategyOpsLib.payoutHarvestProceeds(
                token,
                _wrappedNativeToken,
                recipient,
                withdrawnToVault
            );
        } else {
            uint256 maxYield = _rawHarvestableYield(token, strategy);
            if (maxYield == 0 || amount > maxYield) revert IL1TreasuryVault.YieldNotAvailable();

            (uint256 reported, uint256 measured) = VaultStrategyOpsLib.deallocateLegacyWithBalanceDelta(
                token,
                strategy,
                amount,
                false
            );
            if (reported != measured) {
                emit StrategyReportedReceivedMismatch(token, strategy, reported, measured);
            }
            if (measured > maxYield) revert IL1TreasuryVault.YieldNotAvailable();
            received = VaultStrategyOpsLib.payoutHarvestProceeds(token, _wrappedNativeToken, recipient, measured);
        }

        if (received < minReceived) revert IL1TreasuryVault.SlippageExceeded();
        emit YieldHarvested(token, strategy, recipient, amount, received);
    }

    // --------- Internal helpers ---------

    /**
     * @notice Executes the V2 harvest withdrawal with residual check, reconciliation guards, and exit-cap check.
     * @dev Extracted to avoid stack-too-deep in `harvestYieldFromStrategy`.
     */
    function _executePolicyHarvest(
        address token,
        address strategy,
        uint256 amount
    ) private returns (uint256 withdrawnToVault) {
        uint256 costBasis = _strategyCostBasis[token][strategy];

        // Harvest gate: policyActive required UNLESS costBasis == 0 (final residual sweep)
        if (costBasis > 0) {
            _requireActiveStrategyPolicy(token, strategy);
        } else {
            _requireConfiguredStrategyPolicy(token, strategy);
        }

        uint24 exitCapHundredthBps = _strategyPolicyConfigs[token][strategy].exitCapHundredthBps;

        uint256 residual = VaultStrategyOpsLib.rawHarvestableYield(token, strategy, costBasis);
        if (residual == 0 || amount > residual) revert IL1TreasuryVault.YieldNotAvailable();

        withdrawnToVault = _withdrawPolicyStrategyWithBalanceDelta(token, strategy, amount);

        // Exit-cap check (harvest is an exit path)
        uint256 fee = amount - withdrawnToVault;
        uint256 maxFee = VaultStrategyOpsLib.feeCapAmount(amount, exitCapHundredthBps);
        if (fee > maxFee) {
            revert IL1TreasuryVault.FeeCapExceeded(token, strategy, fee, maxFee);
        }
        // No reimbursement on harvest — GRVT's cost
    }

    /**
     * @notice Returns active V2 lane policy config or reverts.
     * @dev Used on allocation and harvest paths that require `policyActive = true`.
     */
    function _requireActiveStrategyPolicy(
        address token,
        address strategy
    ) private view returns (IL1TreasuryVault.StrategyPolicyConfig memory policy) {
        policy = _requireConfiguredStrategyPolicy(token, strategy);
        if (!policy.policyActive) revert IL1TreasuryVault.V2StrategyPolicyInactive(token, strategy);
    }

    /**
     * @notice Returns configured V2 lane policy config or reverts.
     * @dev The vault relies on the V2 marker plus `vaultToken()` match to distinguish V2 lanes.
     */
    function _requireConfiguredStrategyPolicy(
        address token,
        address strategy
    ) private view returns (IL1TreasuryVault.StrategyPolicyConfig memory policy) {
        if (!_hasStrategyPolicyConfig[token][strategy]) {
            revert IL1TreasuryVault.InvalidV2StrategyPolicy(token, strategy);
        }

        policy = _strategyPolicyConfigs[token][strategy];
    }

    /**
     * @notice Requests unconditional fee reimbursement from the configured treasury.
     * @dev Reverts unless the treasury returns exactly the requested amount.
     */
    function _reimburseFromTreasury(address token, address strategy, uint256 fee) private {
        address treasury = _yieldRecipient;
        (uint256 reported, uint256 measured) = VaultStrategyOpsLib.reimburseFee(token, treasury, strategy, fee);
        if (reported != fee || measured != fee) {
            revert IL1TreasuryVault.FeeReimbursementFailed(token, strategy, fee, measured);
        }
    }

    /**
     * @notice Requires the current yield recipient treasury to be compatible for reimbursement.
     */
    function _requireCompatibleTreasury(address token, address strategy) private view {
        address treasury = _yieldRecipient;
        if (!VaultStrategyOpsLib.isCompatibleFeeReimburser(treasury)) {
            revert IL1TreasuryVault.InvalidV2StrategyPolicy(token, strategy);
        }
        if (!IFeeReimburser(treasury).isAuthorizedVault(address(this))) {
            revert IL1TreasuryVault.InvalidV2StrategyPolicy(token, strategy);
        }
    }

    /**
     * @notice Executes one V2 withdrawal and measures the vault-side receipt.
     * @dev Shared by tracked deallocation and harvest paths to keep the receipt guards identical.
     */
    function _withdrawPolicyStrategyWithBalanceDelta(
        address token,
        address strategy,
        uint256 amount
    ) private returns (uint256 received) {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        uint256 reported = IYieldStrategyV2(strategy).withdraw(amount);
        uint256 balAfter = IERC20(token).balanceOf(address(this));

        if (balAfter < balBefore) revert IL1TreasuryVault.InvalidParam();
        received = balAfter - balBefore;
        if (received > amount) {
            revert IL1TreasuryVault.StrategyAccountingMismatch(token, strategy, received, amount);
        }
        if (reported != received) {
            emit StrategyReportedReceivedMismatch(token, strategy, reported, received);
        }
    }

    /**
     * @notice Returns raw harvestable value for one strategy lane.
     * @dev Returns zero when defensive withdrawal is disabled for the pair.
     */
    function _rawHarvestableYield(address token, address strategy) private view returns (uint256) {
        if (!VaultStrategyOpsLib.canWithdrawVaultTokenFromStrategy(_vaultTokenStrategyConfigs[token][strategy])) {
            return 0;
        }
        return VaultStrategyOpsLib.rawHarvestableYield(token, strategy, _strategyCostBasis[token][strategy]);
    }

    /// @notice Decreases tracked cost basis for one strategy lane, clamped at zero.
    function _decreaseStrategyCostBasis(address token, address strategy, uint256 delta) private {
        if (delta == 0) return;
        uint256 previousCostBasis = _strategyCostBasis[token][strategy];
        if (previousCostBasis == 0) return;
        uint256 decreaseBy = delta < previousCostBasis ? delta : previousCostBasis;
        _strategyCostBasis[token][strategy] = previousCostBasis - decreaseBy;
    }
}
