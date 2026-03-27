// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IAaveGsm} from "../external/IAaveGsm.sol";
import {IStkGhoStaking} from "../external/IStkGhoStaking.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title GsmStkGhoStrategy
 * @notice Vault-only strategy for moving one stablecoin lane into `stkGHO`.
 *
 * In plain terms:
 * - the vault sends in one configured token, such as USDC or USDT,
 * - the strategy swaps that token into GHO through GSM,
 * - the GHO is then staked into `stkGHO`,
 * - the strategy holds `stkGHO` as the invested position.
 *
 * When funds come back out, the strategy unwinds that path in reverse:
 * - convert `stkGHO` back into GHO,
 * - swap GHO back into the vault token,
 * - send the vault token back to the vault.
 *
 * This strategy keeps two buckets:
 * - "tracked value" is the part that came from normal vault allocations,
 * - "residual value" is everything else, such as share-price growth, rounding leftovers,
 *   or tokens sent directly to the strategy outside the normal vault flow.
 *
 * The split matters because only tracked exits may ask the treasury to cover the exit fee.
 * Residual value must never be treated like vault-funded value.
 *
 * Operational rules:
 * - `strategyExposure()` reports value in vault-token terms, because that is what the vault accounts in.
 * - `withdrawTracked()` is the dedicated tracked-value exit used when reimbursement is enabled.
 * - `withdrawResidual()` and `withdrawAllResidual()` are the explicit residual-only paths.
 * - idle GHO is restaked whenever the strategy changes state, so GHO should usually stay near zero
 *   unless something external sent tokens directly into the strategy.
 *
 * Supported lane assumption:
 * - this strategy is intended for stablecoin lanes such as USDC and USDT,
 * - minting through GSM is assumed to be 1:1 into GHO for those lanes,
 * - any explicit exit cost is represented by the GSM exit fee rather than by a discounted mint.
 *
 * Internally, the strategy keeps just enough state to answer one question correctly:
 * how much of the current `stkGHO` position still belongs to vault-funded value?
 * That matters because `stkGHO` can change in value over time, so the full balance should not be
 * assumed to be reimbursable.
 */
contract GsmStkGhoStrategy is Initializable, ReentrancyGuardUpgradeable, IYieldStrategyV2 {
    using SafeERC20 for IERC20;

    /// @dev Caller is not the configured vault.
    error Unauthorized();
    /// @dev Input address or amount is zero, unsupported, or otherwise malformed for this lane.
    error InvalidParam();

    /// @notice Vault that is allowed to move funds through this strategy.
    address public vault;
    /// @notice Single vault token supported by this deployment.
    address public override vaultToken;
    /// @notice GHO token used as the middle step between the vault token and `stkGHO`.
    address public gho;
    /// @notice Staked GHO token held as the invested position.
    address public stkGho;
    /// @notice GSM adapter used for `vaultToken <-> GHO` swaps.
    address public gsm;
    /// @notice Staking adapter used for `GHO <-> stkGHO` conversion.
    address public stakingAdapter;
    string private _strategyName;
    /// @notice Amount of redeemable asset value that still counts as tracked vault-funded value.
    uint256 private _trackedAssetClaim;
    /// @notice stkGHO shares still backing that tracked value.
    uint256 private _trackedBackingShares;

    uint256[50] private __gap;

    /// @notice Emitted after a successful full allocate path into stkGHO.
    event Allocated(address indexed vaultToken, uint256 amountIn, uint256 ghoOut, uint256 stkGhoStaked);
    /// @notice Emitted after any deallocation path returns funds to the vault.
    event Deallocated(address indexed vaultToken, uint256 requested, uint256 received, uint256 reimbursableFee);
    /// @notice Emitted when idle `vaultToken` is swept back to the vault.
    event UninvestedTokenSwept(address indexed token, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes one vault-token lane for the GSM -> stkGHO strategy.
     * @dev Reverts if any address is zero or the name is empty.
     * @param vault_ Vault allowed to move funds through this strategy.
     * @param vaultToken_ Single vault token supported by this deployment.
     * @param gho_ GHO token used as the middle asset.
     * @param stkGho_ Staked GHO token held by the strategy.
     * @param gsm_ GSM router used for `vaultToken <-> GHO` swaps.
     * @param stakingAdapter_ Staking adapter used for `GHO <-> stkGHO` conversions.
     * @param strategyName_ Human-readable strategy identifier.
     */
    function initialize(
        address vault_,
        address vaultToken_,
        address gho_,
        address stkGho_,
        address gsm_,
        address stakingAdapter_,
        string calldata strategyName_
    ) external initializer {
        if (
            vault_ == address(0) ||
            vaultToken_ == address(0) ||
            gho_ == address(0) ||
            stkGho_ == address(0) ||
            gsm_ == address(0) ||
            stakingAdapter_ == address(0) ||
            bytes(strategyName_).length == 0
        ) revert InvalidParam();

        __ReentrancyGuard_init();

        vault = vault_;
        vaultToken = vaultToken_;
        gho = gho_;
        stkGho = stkGho_;
        gsm = gsm_;
        stakingAdapter = stakingAdapter_;
        _strategyName = strategyName_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    /// @inheritdoc IYieldStrategyV2
    function isYieldStrategyV2() external pure returns (bytes4) {
        return IYieldStrategyV2.isYieldStrategyV2.selector;
    }

    /// @inheritdoc IYieldStrategyV2
    function name() external view override returns (string memory) {
        return _strategyName;
    }

    /// @inheritdoc IYieldStrategyV2
    function exactTokenBalance(address token) external view override returns (uint256) {
        if (token == vaultToken || token == gho || token == stkGho) {
            return IERC20(token).balanceOf(address(this));
        }
        return 0;
    }

    /// @inheritdoc IYieldStrategyV2
    function tvlTokens() external view returns (address[] memory tokens) {
        tokens = new address[](3);
        tokens[0] = vaultToken;
        tokens[1] = gho;
        tokens[2] = stkGho;
    }

    /// @inheritdoc IYieldStrategyV2
    function positionBreakdown() external view returns (PositionComponent[] memory components) {
        uint256 invested = IERC20(stkGho).balanceOf(address(this));
        uint256 ghoResidual = IERC20(gho).balanceOf(address(this));
        uint256 tokenResidual = IERC20(vaultToken).balanceOf(address(this));

        uint256 len = (invested == 0 ? 0 : 1) + (ghoResidual == 0 ? 0 : 1) + (tokenResidual == 0 ? 0 : 1);
        if (len == 0) return components;

        components = new PositionComponent[](len);
        uint256 index;

        if (invested != 0) {
            components[index] = PositionComponent({
                token: stkGho,
                amount: invested,
                kind: PositionComponentKind.InvestedPosition
            });
            ++index;
        }
        if (ghoResidual != 0) {
            components[index] = PositionComponent({
                token: gho,
                amount: ghoResidual,
                kind: PositionComponentKind.UninvestedToken
            });
            ++index;
        }
        if (tokenResidual != 0) {
            components[index] = PositionComponent({
                token: vaultToken,
                amount: tokenResidual,
                kind: PositionComponentKind.UninvestedToken
            });
        }
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Exposure is reported in `vaultToken` units after previewing the current exit fee.
     * Treasury reimbursement is intentionally excluded because that is vault policy, not strategy exposure.
     */
    function strategyExposure() external view returns (uint256 exposure) {
        uint256 directVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 grossGhoAssets = _totalGhoAssets();
        if (grossGhoAssets == 0) return directVaultToken;

        (uint256 netVaultToken, ) = IAaveGsm(gsm).previewSwapGhoToAsset(vaultToken, grossGhoAssets);
        return directVaultToken + netVaultToken;
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Pulls `vaultToken` from the vault, swaps into GHO through GSM, then stakes into `stkGHO`.
     * Each external swap uses the latest preview as a minimum bound, so the call reverts if the
     * outcome is worse than expected. Token approvals are reset back to zero after use.
     */
    function allocate(uint256 amount) external onlyVault nonReentrant {
        _requireNonZeroAmount(amount);

        IERC20(vaultToken).safeTransferFrom(vault, address(this), amount);

        IERC20(vaultToken).forceApprove(gsm, amount);
        uint256 minGhoOut = IAaveGsm(gsm).previewSwapAssetToGho(vaultToken, amount);
        uint256 ghoOut = IAaveGsm(gsm).swapAssetToGho(vaultToken, amount, minGhoOut, address(this));
        IERC20(vaultToken).forceApprove(gsm, 0);

        IERC20(gho).forceApprove(stakingAdapter, ghoOut);
        uint256 stkGhoOut = IStkGhoStaking(stakingAdapter).stake(ghoOut, address(this));
        IERC20(gho).forceApprove(stakingAdapter, 0);
        _trackedAssetClaim += ghoOut;
        _trackedBackingShares += stkGhoOut;

        emit Allocated(vaultToken, amount, ghoOut, stkGhoOut);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawAllTracked() external onlyVault nonReentrant returns (uint256 received, uint256 reimbursableFee) {
        (received, reimbursableFee) = _withdrawAllTracked();
        emit Deallocated(vaultToken, type(uint256).max, received, reimbursableFee);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawTracked(
        uint256 amount
    ) external onlyVault nonReentrant returns (uint256 received, uint256 reimbursableFee) {
        _requireNonZeroAmount(amount);

        (received, reimbursableFee) = _withdrawTrackedAmount(amount);
        emit Deallocated(vaultToken, amount, received, reimbursableFee);
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev This reports only leftover value. It intentionally excludes anything still counted as
     * tracked vault-funded value, even if that tracked value has grown inside `stkGHO`.
     */
    function residualExposure() external view returns (uint256 exposure) {
        exposure = IERC20(vaultToken).balanceOf(address(this));
        uint256 residualGhoAssets = _residualGhoAssets();
        if (residualGhoAssets == 0) return exposure;

        (uint256 residualVaultToken, ) = IAaveGsm(gsm).previewSwapGhoToAsset(vaultToken, residualGhoAssets);
        return exposure + residualVaultToken;
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawResidual(uint256 amount) external onlyVault nonReentrant returns (uint256 received) {
        _requireNonZeroAmount(amount);

        received = _deallocateResidualToTarget(amount);
        emit Deallocated(vaultToken, amount, received, 0);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawAllResidual() external onlyVault nonReentrant returns (uint256 received) {
        received = _deallocateAllResidual();
        emit Deallocated(vaultToken, type(uint256).max, received, 0);
    }

    /**
     * @notice Realizes enough leftover value to reach a target vault-token amount.
     * @dev The flow is:
     * 1. sweep any idle vault token already sitting in the strategy,
     * 2. convert the remaining vault-token target into the GHO amount that must be unwound,
     * 3. consume only the residual bucket for that amount.
     */
    function _deallocateResidualToTarget(uint256 requested) internal returns (uint256 received) {
        received = _sweepVaultTokenToVaultUpTo(requested);
        if (received >= requested) return received;

        uint256 remaining = requested - received;
        (uint256 residualAssetsTarget, ) = IAaveGsm(gsm).previewExactAssetOutFromGho(vaultToken, remaining);
        received += _consumeResidualAssets(residualAssetsTarget, remaining);
        return received;
    }

    /**
     * @notice Realizes every leftover balance the strategy currently holds.
     * @dev This first sweeps idle vault token, then unwinds all remaining residual GHO/stkGHO value.
     */
    function _deallocateAllResidual() internal returns (uint256 received) {
        received = _sweepVaultTokenToVaultUpTo(type(uint256).max);
        received += _consumeResidualAssets(_residualGhoAssets(), type(uint256).max);
        return received;
    }

    /**
     * @notice Realizes a tracked amount expressed in vault-token units.
     * @dev The vault thinks in vault-token units. The strategy converts that request into the
     * internal tracked asset claim before unwinding the tracked bucket.
     */
    function _withdrawTrackedAmount(
        uint256 trackedAmount
    ) internal returns (uint256 received, uint256 reimbursableFee) {
        if (_trackedAssetClaim == 0) return (0, 0);

        uint256 assetClaimAmount = IAaveGsm(gsm).previewSwapAssetToGho(vaultToken, trackedAmount);
        if (assetClaimAmount > _trackedAssetClaim) assetClaimAmount = _trackedAssetClaim;
        if (assetClaimAmount == 0) return (0, 0);

        return _consumeTrackedAssets(assetClaimAmount, trackedAmount);
    }

    /**
     * @notice Fully unwinds the tracked bucket.
     */
    function _withdrawAllTracked() internal returns (uint256 received, uint256 reimbursableFee) {
        uint256 trackedAssetClaim = _trackedAssetClaim;
        if (trackedAssetClaim == 0) return (0, 0);
        (received, reimbursableFee) = _consumeTrackedAssets(trackedAssetClaim, type(uint256).max);
    }

    /**
     * @notice Consumes a slice of the tracked bucket and returns vault token to the vault.
     * @dev Reading order:
     * 1. restake any idle GHO so the strategy starts from one clean invested position,
     * 2. choose how much tracked asset claim to consume,
     * 3. burn the stkGHO shares needed for that claim,
     * 4. swap the resulting GHO back into the vault token,
     * 5. update tracked ledgers,
     * 6. restake any leftover GHO so rounding residue becomes residual value, not idle state.
     *
     * `sweepCap` limits the vault-token output for this tracked unwind.
     */
    function _consumeTrackedAssets(
        uint256 trackedAssetClaimAmount,
        uint256 sweepCap
    ) internal returns (uint256 received, uint256 reimbursableFee) {
        // Keep the resting state simple: invested stkGHO plus optional vault-token leftovers.
        _restakeIdleGho();

        uint256 trackedBackingShares = _trackedBackingSharesAvailable();
        uint256 trackedAssetClaim = _trackedAssetClaim;
        if (trackedBackingShares == 0 || trackedAssetClaim == 0 || trackedAssetClaimAmount == 0) return (0, 0);
        uint256 vaultTokenBeforeSwap = IERC20(vaultToken).balanceOf(address(this));

        // Never consume more than the tracked claim that is still outstanding.
        uint256 assetsToConsume = trackedAssetClaimAmount;
        if (assetsToConsume > trackedAssetClaim) assetsToConsume = trackedAssetClaim;

        // Preview how many shares must be burned to redeem the requested tracked assets.
        uint256 sharesToBurn = IStkGhoStaking(stakingAdapter).previewWithdraw(assetsToConsume);
        if (sharesToBurn > trackedBackingShares) sharesToBurn = trackedBackingShares;
        if (sharesToBurn == 0) return (0, 0);

        // Convert only that tracked slice back into GHO, then into the vault token.
        uint256 unstakedAssets = _unstakeGho(sharesToBurn);
        if (assetsToConsume > unstakedAssets) assetsToConsume = unstakedAssets;

        if (assetsToConsume != 0) {
            (, reimbursableFee) = _swapGhoToVaultToken(assetsToConsume, address(this));
        }

        // The tracked ledgers move down only by the slice that was actually consumed.
        _trackedBackingShares = trackedBackingShares - sharesToBurn;
        _trackedAssetClaim = trackedAssetClaim - assetsToConsume;

        // Any GHO left behind after the swap is treated as residual and restaked.
        _restakeIdleGho();
        uint256 strategyPathOutput = IERC20(vaultToken).balanceOf(address(this)) - vaultTokenBeforeSwap;
        received = strategyPathOutput;
        if (received > sweepCap) received = sweepCap;
        _transferVaultTokenToVault(received);
    }

    /**
     * @notice Consumes a slice of the residual bucket and returns vault token to the vault.
     * @dev Residual value can come from pure leftover shares, idle GHO, or appreciation sitting above
     * the tracked asset claim. This path realizes only that leftover value and leaves the tracked claim unchanged.
     */
    function _consumeResidualAssets(uint256 residualAssetAmount, uint256 sweepCap) internal returns (uint256 received) {
        // Start from the same clean resting state used by tracked exits.
        _restakeIdleGho();

        uint256 totalShares = IERC20(stkGho).balanceOf(address(this));
        if (totalShares == 0 || residualAssetAmount == 0) return 0;

        uint256 trackedBackingShares = _trackedBackingSharesAvailable(totalShares);
        uint256 residualAssetsAvailable = _residualGhoAssets(totalShares, trackedBackingShares);
        if (residualAssetsAvailable == 0) return 0;

        // Never realize more residual value than is currently available.
        uint256 assetsToConsume = residualAssetAmount;
        if (assetsToConsume > residualAssetsAvailable) assetsToConsume = residualAssetsAvailable;

        // Burn the shares needed to redeem that amount of leftover value.
        uint256 sharesToBurn = IStkGhoStaking(stakingAdapter).previewWithdraw(assetsToConsume);
        if (sharesToBurn > totalShares) sharesToBurn = totalShares;
        if (sharesToBurn == 0) return 0;

        uint256 residualShares = totalShares - trackedBackingShares;
        uint256 unstakedAssets = _unstakeGho(sharesToBurn);

        // If redeeming leftover value had to dip into tracked-backing shares, reduce only the share
        // ledger. The tracked asset claim itself stays unchanged because this path must not realize it.
        _applyResidualShareBurn(sharesToBurn, residualShares, trackedBackingShares);

        if (assetsToConsume > unstakedAssets) assetsToConsume = unstakedAssets;
        if (assetsToConsume != 0) {
            _swapGhoToVaultToken(assetsToConsume, address(this));
        }

        // Keep any leftover GHO invested and sweep only vault token back to the vault.
        _restakeIdleGho();
        received = _sweepVaultTokenToVaultUpTo(sweepCap);
    }

    /**
     * @notice Swaps GHO back into the vault token through GSM.
     * @dev Uses the previewed output as the minimum accepted amount so the call fails if the
     * actual exit would be worse than the latest quote.
     */
    function _swapGhoToVaultToken(
        uint256 ghoAmount,
        address recipient
    ) internal returns (uint256 assetOut, uint256 fee) {
        (uint256 minAssetOut, ) = IAaveGsm(gsm).previewSwapGhoToAsset(vaultToken, ghoAmount);
        IERC20(gho).forceApprove(gsm, ghoAmount);
        (assetOut, fee) = IAaveGsm(gsm).swapGhoToAsset(vaultToken, ghoAmount, minAssetOut, recipient);
        IERC20(gho).forceApprove(gsm, 0);
    }

    /**
     * @notice Stakes any idle GHO back into `stkGHO`.
     * @dev The strategy tries to avoid leaving GHO idle after state changes so later reads and exits
     * can reason about one main invested position plus explicit leftovers.
     *
     * Very small GHO balances can appear from rounding or direct transfers once `stkGHO` share price
     * drifts above 1. Those balances are left idle instead of attempting a restake that would mint
     * zero shares and revert the whole exit path.
     */
    function _restakeIdleGho() internal {
        uint256 ghoBalance = IERC20(gho).balanceOf(address(this));
        if (ghoBalance == 0) return;

        uint256 oneShareAssetValue = IStkGhoStaking(stakingAdapter).convertToAssets(1);
        if (oneShareAssetValue != 0 && ghoBalance <= oneShareAssetValue) return;

        IERC20(gho).forceApprove(stakingAdapter, ghoBalance);
        IStkGhoStaking(stakingAdapter).stake(ghoBalance, address(this));
        IERC20(gho).forceApprove(stakingAdapter, 0);
    }

    /**
     * @notice Unstakes `stkGHO` shares back into GHO.
     * @param amount Number of `stkGHO` shares to burn.
     * @return assets GHO returned by the staking adapter.
     */
    function _unstakeGho(uint256 amount) internal returns (uint256 assets) {
        if (amount == 0) return 0;
        IERC20(stkGho).forceApprove(stakingAdapter, amount);
        assets = IStkGhoStaking(stakingAdapter).unstake(amount, address(this));
        IERC20(stkGho).forceApprove(stakingAdapter, 0);
    }

    /**
     * @notice Returns the full GHO-equivalent asset value currently held by the strategy.
     * @dev This includes idle GHO and the GHO asset value represented by all `stkGHO` shares.
     */
    function _totalGhoAssets() internal view returns (uint256 totalAssets) {
        uint256 totalShares = IERC20(stkGho).balanceOf(address(this));
        totalAssets = IERC20(gho).balanceOf(address(this));
        if (totalShares != 0) totalAssets += IStkGhoStaking(stakingAdapter).convertToAssets(totalShares);
    }

    /**
     * @notice Returns the GHO-equivalent asset value that belongs to the residual bucket.
     * @dev This helper uses the current on-chain share balance and the tracked share ledger.
     */
    function _residualGhoAssets() internal view returns (uint256 residualAssets) {
        uint256 totalShares = IERC20(stkGho).balanceOf(address(this));
        return _residualGhoAssets(totalShares, _trackedBackingSharesAvailable(totalShares));
    }

    /**
     * @notice Returns residual GHO-equivalent assets for a known share split.
     * @dev Residual value can come from three places:
     * 1. idle GHO,
     * 2. shares that are not part of the tracked bucket,
     * 3. appreciation sitting above the tracked asset claim on tracked-backing shares.
     */
    function _residualGhoAssets(
        uint256 totalShares,
        uint256 trackedBackingShares
    ) internal view returns (uint256 residualAssets) {
        residualAssets = IERC20(gho).balanceOf(address(this));

        uint256 residualShares = totalShares - trackedBackingShares;
        if (residualShares != 0) {
            residualAssets += IStkGhoStaking(stakingAdapter).convertToAssets(residualShares);
        }

        uint256 trackedBackingAssets = IStkGhoStaking(stakingAdapter).convertToAssets(trackedBackingShares);
        if (trackedBackingAssets > _trackedAssetClaim) {
            residualAssets += trackedBackingAssets - _trackedAssetClaim;
        }
    }

    /**
     * @notice Returns the tracked share ledger, capped by the actual share balance.
     * @dev This protects reads if external transfers or rounding leave the stored share ledger
     * temporarily above the live share balance.
     */
    function _trackedBackingSharesAvailable() internal view returns (uint256 trackedBackingShares) {
        return _trackedBackingSharesAvailable(IERC20(stkGho).balanceOf(address(this)));
    }

    /**
     * @notice Returns the tracked share ledger for a known total share balance.
     * @param totalShares Current live `stkGHO` share balance.
     * @return trackedBackingShares Tracked share amount, capped by `totalShares`.
     */
    function _trackedBackingSharesAvailable(uint256 totalShares) internal view returns (uint256 trackedBackingShares) {
        trackedBackingShares = _trackedBackingShares;
        if (trackedBackingShares > totalShares) return totalShares;
    }

    /**
     * @notice Applies share-ledger changes when a residual exit has to burn tracked-backing shares.
     * @dev Residual value may sit partly on top of tracked-backing shares when `stkGHO` has appreciated.
     * In that case the residual exit is allowed to burn some tracked-backing shares, but only the share
     * ledger moves down here. The tracked asset claim stays untouched.
     */
    function _applyResidualShareBurn(
        uint256 sharesBurned,
        uint256 residualShares,
        uint256 trackedBackingShares
    ) internal {
        if (sharesBurned <= residualShares) return;
        _trackedBackingShares = trackedBackingShares - (sharesBurned - residualShares);
    }

    /**
     * @notice Sweeps idle vault token back to the vault, up to `maxAmount`.
     * @dev This is the first step in both tracked and residual exits because idle vault token
     * can be returned without touching GHO or `stkGHO`.
     */
    function _sweepVaultTokenToVaultUpTo(uint256 maxAmount) internal returns (uint256 swept) {
        swept = IERC20(vaultToken).balanceOf(address(this));
        if (swept > maxAmount) swept = maxAmount;
        if (swept == 0) return 0;

        _transferVaultTokenToVault(swept);
    }

    /**
     * @notice Transfers idle vault token back to the vault.
     * @param amount Amount of vault token to return.
     */
    function _transferVaultTokenToVault(uint256 amount) internal {
        if (amount == 0) return;
        IERC20(vaultToken).safeTransfer(vault, amount);
        emit UninvestedTokenSwept(vaultToken, amount);
    }

    function _requireVaultToken(address queriedVaultToken) internal view {
        if (queriedVaultToken != vaultToken) revert InvalidParam();
    }

    function _requireNonZeroAmount(uint256 amount) internal pure {
        if (amount == 0) revert InvalidParam();
    }
}
