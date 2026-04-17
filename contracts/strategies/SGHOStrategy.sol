// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IAaveGsm} from "../external/IAaveGsm.sol";
import {IAaveGsmFeeStrategy} from "../external/IAaveGsmFeeStrategy.sol";
import {IAaveGsmPriceStrategy} from "../external/IAaveGsmPriceStrategy.sol";
import {IAaveV3AToken} from "../external/IAaveV3AToken.sol";
import {IStataTokenV2} from "../external/IStataTokenV2.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title SGHOStrategy
 * @notice Vault-only single-lane strategy for the `vaultToken -> GSM -> GHO -> sGHO` route.
 * @dev This strategy holds no tracked-principal state. The vault owns cost basis, residual yield,
 *      fee inference, and reimbursement policy.
 *
 *      Reporting model:
 *      - `totalExposure()` reports economic value before exit fees.
 *      - `withdrawableExposure()` reports the portion operationally withdrawable now, still before exit fees.
 *      - for this stablecoin lane, direct `GHO` and `sGHO` preview value are treated as the same
 *        accounting unit as `vaultToken`; the vault handles explicit exit fees separately
 *
 *      Exit model:
 *      - exits are fail-closed
 *      - if the `sGHO` leg cannot provide the required GHO amount, `withdraw()` reverts
 *      - the strategy does not partially unwind
 *
 *      Route assumptions:
 *      - `sGHO` is a compliant ERC4626 vault over GHO, so ERC4626 previews and `maxWithdraw()`
 *        are the correct sources for economic value and withdrawable-now liquidity
 *      - the GSM underlying asset is the expected static-aToken over `vaultToken`
 *      - the GSM and `sGHO` use the same GHO token
 *      - the GSM `PRICE_RATIO` is `1.0` at initialization
 *      - the wrapped static-aToken starts at a 1:1 ERC4626 exchange rate with `vaultToken` and
 *        may appreciate over time
 *      - the GSM sell fee is `0` at initialization, so entry loss should only be rounding or dust
 *
 *      Failure model:
 *      - bad lane configuration reverts with `InvalidInitializationParams` or `InvalidGsmConfig`
 *      - inconsistent GSM quote or settlement reverts with `GsmQuoteMismatch` or
 *        `GsmSettlementMismatch`
 */
contract SGHOStrategy is Initializable, ReentrancyGuardUpgradeable, IYieldStrategyV2 {
    using SafeERC20 for IERC20;
    using SafeERC20 for IStataTokenV2;

    error UnauthorizedCaller();
    error InvalidInitializationParams();
    error InvalidSGhoAsset();
    error ZeroAmount();
    error GsmQuoteMismatch();
    error GsmSettlementMismatch();
    error ReportedInvestmentExceedsInput(uint256 invested, uint256 amount);
    error SGhoDepositReturnedZeroShares();
    error SGhoWithdrawSettlementMismatch();
    error InsufficientRedeemableLiquidity(uint256 requested, uint256 available);
    error InvalidGsmConfig();

    address public vault;
    address public override vaultToken;
    IERC20 public ghoToken;
    IERC4626 public sGhoToken;
    IAaveGsm public ghoGsm;
    string private _strategyName;
    IStataTokenV2 public gsmStataToken;

    uint256 private constant EXPECTED_GSM_PRICE_RATIO = 1e18; // GSM par ratio, not the static-token exchange rate

    uint256[50] private __gap;

    event Allocated(
        address indexed vaultToken,
        uint256 amountIn,
        uint256 invested,
        uint256 ghoOut,
        uint256 sGhoSharesReceived
    );
    event Withdrawn(address indexed vaultToken, uint256 requested, uint256 received);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes one vault-token lane for the GSM -> sGHO strategy.
     * @dev Derives `ghoToken` from `IERC4626(sGho).asset()` and validates the explicit `vaultToken`
     *      against the GSM asset chain. This strategy only supports the wrapped stable-token route:
     *      `gsm.UNDERLYING_ASSET()` must be a static token whose ERC4626 asset and wrapped
     *      `aToken()` underlying both resolve back to `vaultToken`.
     *      It also pins the current GSM assumptions this lane relies on: `PRICE_RATIO == 1.0`
     *      and zero sell fee on the entry path. The static-aToken itself is still expected to
     *      begin at a 1:1 ERC4626 exchange rate and drift upward over time.
     */
    function initialize(
        address vault_,
        address vaultToken_,
        address sGho_,
        address gsm_,
        string calldata strategyName_
    ) external initializer {
        if (
            vault_ == address(0) ||
            vaultToken_ == address(0) ||
            sGho_ == address(0) ||
            gsm_ == address(0) ||
            bytes(strategyName_).length == 0
        ) {
            revert InvalidInitializationParams();
        }

        __ReentrancyGuard_init();

        if (gsm_.code.length == 0) revert InvalidInitializationParams();
        if (sGho_.code.length == 0) revert InvalidSGhoAsset();

        IERC20 derivedGhoToken;
        try IERC4626(sGho_).asset() returns (address assetToken) {
            if (assetToken == address(0)) revert InvalidSGhoAsset();
            derivedGhoToken = IERC20(assetToken);
        } catch {
            revert InvalidSGhoAsset();
        }

        address gsmAsset = IAaveGsm(gsm_).UNDERLYING_ASSET();
        if (!_isWrappedGsmAssetForVaultToken(vaultToken_, gsmAsset)) revert InvalidInitializationParams();
        if (IAaveGsm(gsm_).GHO_TOKEN() != address(derivedGhoToken)) {
            revert InvalidInitializationParams();
        }
        _requireExpectedGsmConfigAtInitialization(IAaveGsm(gsm_));

        vault = vault_;
        vaultToken = vaultToken_;
        ghoToken = derivedGhoToken;
        sGhoToken = IERC4626(sGho_);
        ghoGsm = IAaveGsm(gsm_);
        _strategyName = strategyName_;
        gsmStataToken = IStataTokenV2(gsmAsset);
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert UnauthorizedCaller();
        _;
    }

    /// @inheritdoc IYieldStrategyV2
    function isYieldStrategyV2() external pure returns (bytes4) {
        return IYieldStrategyV2.isYieldStrategyV2.selector;
    }

    /**
     * @notice Human-readable strategy identifier.
     * @dev This is immutable after initialization.
     */
    function name() external view returns (string memory) {
        return _strategyName;
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Reports economic value, not current withdrawable-now liquidity.
     */
    function totalExposure() external view returns (uint256 exposure) {
        uint256 idleVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 idleStataVaultTokenValue = _idleStataEconomicValue();
        uint256 totalGhoValue = ghoToken.balanceOf(address(this)) + _sGhoValue();
        return idleVaultToken + idleStataVaultTokenValue + totalGhoValue;
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Reports the subset of economic value that is withdrawable now, before exit fees.
     */
    function withdrawableExposure() external view returns (uint256 exposure) {
        uint256 idleVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 idleStataVaultTokenValue = _idleStataWithdrawableValue();
        uint256 totalGhoValue = ghoToken.balanceOf(address(this)) + _sGhoWithdrawableValue();
        return idleVaultToken + idleStataVaultTokenValue + totalGhoValue;
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Unsupported tokens return zero instead of reverting.
     */
    function exactTokenBalance(address token) external view returns (uint256 amount) {
        if (
            token == vaultToken ||
            token == address(ghoToken) ||
            token == address(sGhoToken) ||
            token == address(gsmStataToken)
        ) {
            return IERC20(token).balanceOf(address(this));
        }
        return 0;
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev The vault tracks the full wrapped route for accounting and diagnostics.
     */
    function tvlTokens() external view returns (address[] memory tokens) {
        tokens = new address[](4);
        tokens[0] = vaultToken;
        tokens[1] = address(ghoToken);
        tokens[2] = address(sGhoToken);
        tokens[3] = address(gsmStataToken);
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev `sGHO` is the invested position; idle route tokens are uninvested inventory.
     */
    function positionBreakdown() external view returns (PositionComponent[] memory components) {
        uint256 investedShares = sGhoToken.balanceOf(address(this));
        uint256 idleGho = ghoToken.balanceOf(address(this));
        uint256 idleVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 idleStataToken = gsmStataToken.balanceOf(address(this));

        uint256 len = (investedShares == 0 ? 0 : 1) +
            (idleGho == 0 ? 0 : 1) +
            (idleVaultToken == 0 ? 0 : 1) +
            (idleStataToken == 0 ? 0 : 1);
        if (len == 0) return components;

        components = new PositionComponent[](len);
        uint256 index;

        if (investedShares != 0) {
            components[index] = PositionComponent({
                token: address(sGhoToken),
                amount: investedShares,
                kind: PositionComponentKind.InvestedPosition
            });
            ++index;
        }
        if (idleGho != 0) {
            components[index] = PositionComponent({
                token: address(ghoToken),
                amount: idleGho,
                kind: PositionComponentKind.UninvestedToken
            });
            ++index;
        }
        if (idleStataToken != 0) {
            components[index] = PositionComponent({
                token: address(gsmStataToken),
                amount: idleStataToken,
                kind: PositionComponentKind.UninvestedToken
            });
            ++index;
        }
        if (idleVaultToken != 0) {
            components[index] = PositionComponent({
                token: vaultToken,
                amount: idleVaultToken,
                kind: PositionComponentKind.UninvestedToken
            });
        }
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Reverts if the GSM quote or settlement is inconsistent, if the sGHO deposit returns
     *      zero shares, or if the reported deployed value is greater than the vault-token input.
     */
    function allocate(uint256 amount) external onlyVault nonReentrant returns (uint256 invested) {
        _requireNonZero(amount);

        // Pull the exact vault-token amount into the lane before executing the fixed route.
        IERC20(vaultToken).safeTransferFrom(vault, address(this), amount);

        // Convert the vault token into GHO through the static-aToken GSM sell path.
        (, uint256 ghoOut, ) = _sellVaultTokenForGho(amount, address(this));

        // Deposit the full GHO proceeds into sGHO to establish the invested position.
        ghoToken.forceApprove(address(sGhoToken), ghoOut);
        uint256 sharesOut = sGhoToken.deposit(ghoOut, address(this));
        ghoToken.forceApprove(address(sGhoToken), 0);
        if (sharesOut == 0) revert SGhoDepositReturnedZeroShares();

        // Convert the minted sGHO shares back into net GHO and treat that stable-value amount as invested principal.
        invested = sGhoToken.previewRedeem(sharesOut);
        if (invested > amount) revert ReportedInvestmentExceedsInput(invested, amount);

        emit Allocated(vaultToken, amount, invested, ghoOut, sharesOut);
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Fails closed if the lane cannot source the requested amount from withdrawable GHO.
     */
    function withdraw(uint256 amount) external onlyVault nonReentrant returns (uint256 received) {
        _requireNonZero(amount);

        // Return any idle vault token first before touching the wrapped route.
        received = _sweepVaultTokenToVault(amount);
        if (received >= amount) {
            emit Withdrawn(vaultToken, amount, received);
            return received;
        }

        // Then unwind any idle static-aToken inventory already held by the lane.
        received += _sweepStataTokenToVault(amount - received);
        if (received >= amount) {
            emit Withdrawn(vaultToken, amount, received);
            return received;
        }

        // Quote the remaining exit against both economic and withdrawable capacity.
        uint256 remaining = amount - received;
        (
            uint256 economicVaultTokenCapacity,
            uint256 withdrawableVaultTokenCapacity,
            uint256 stataTokenAmountNeeded
        ) = _quoteStataExitForVaultTokenAmount(remaining);
        if (remaining > withdrawableVaultTokenCapacity && remaining <= economicVaultTokenCapacity) {
            revert InsufficientRedeemableLiquidity(remaining, withdrawableVaultTokenCapacity);
        }
        if (stataTokenAmountNeeded == 0) {
            emit Withdrawn(vaultToken, amount, received);
            return received;
        }

        // Ask the GSM how much GHO is needed to buy the static-aToken needed for the remaining vault token.
        (uint256 quotedStataTokenAmount, uint256 ghoNeeded, , ) = ghoGsm.getGhoAmountForBuyAsset(
            stataTokenAmountNeeded
        );
        if (quotedStataTokenAmount < stataTokenAmountNeeded || ghoNeeded == 0) revert GsmQuoteMismatch();

        // Use idle GHO first, then pull only the missing amount out of sGHO.
        uint256 idleGho = ghoToken.balanceOf(address(this));
        uint256 sGhoAvailable = sGhoToken.maxWithdraw(address(this));
        uint256 ghoToSwap = idleGho < ghoNeeded ? idleGho : ghoNeeded;
        uint256 ghoFromSgho = ghoNeeded - ghoToSwap;
        if (ghoFromSgho != 0) {
            if (ghoFromSgho > sGhoAvailable) {
                ghoFromSgho = sGhoAvailable;
            }

            uint256 beforeBalance = ghoToken.balanceOf(address(this));
            uint256 sharesBurned = sGhoToken.withdraw(ghoFromSgho, address(this), address(this));
            uint256 afterBalance = ghoToken.balanceOf(address(this));
            if (sharesBurned == 0 || afterBalance < beforeBalance || afterBalance - beforeBalance != ghoFromSgho) {
                revert SGhoWithdrawSettlementMismatch();
            }

            ghoToSwap += ghoFromSgho;
        }

        // Spend the sourced GHO on the GSM buy path and redeem the bought static-aToken into vault token.
        if (ghoToSwap != 0) {
            received += _buyVaultTokenWithGho(ghoToSwap, stataTokenAmountNeeded, vault);
        }

        emit Withdrawn(vaultToken, amount, received);
    }

    /**
     * @dev Transfers idle vault token back to the vault before using the GHO leg.
     */
    function _sweepVaultTokenToVault(uint256 maxAmount) internal returns (uint256 swept) {
        swept = IERC20(vaultToken).balanceOf(address(this));
        if (swept > maxAmount) swept = maxAmount;
        if (swept == 0) return 0;
        IERC20(vaultToken).safeTransfer(vault, swept);
    }

    /**
     * @dev Withdraws idle stata shares back into vault token before using the GHO leg.
     */
    function _sweepStataTokenToVault(uint256 maxAmount) internal returns (uint256 swept) {
        swept = gsmStataToken.maxWithdraw(address(this));
        if (swept > maxAmount) swept = maxAmount;
        if (swept == 0) return 0;
        gsmStataToken.withdraw(swept, vault, address(this));
    }

    /**
     * @dev Sells the exact vault-token amount into GHO through the GSM. Returns the exact stata
     *      shares sold, the net GHO received, and the gross pre-fee GHO quote so the strategy can
     *      normalize the deployed value back into vault-token units.
     */
    function _sellVaultTokenForGho(
        uint256 vaultTokenAmount,
        address recipient
    ) internal returns (uint256 stataSharesSold, uint256 ghoOut, uint256 grossGhoOut) {
        // Wrap the vault token into the GSM's static-aToken input asset.
        IERC20(vaultToken).forceApprove(address(gsmStataToken), vaultTokenAmount);
        stataSharesSold = gsmStataToken.deposit(vaultTokenAmount, address(this));
        IERC20(vaultToken).forceApprove(address(gsmStataToken), 0);

        // Quote the sell path first so we can reject bad shapes before settlement.
        (uint256 assetSold, uint256 previewGhoOut, uint256 previewGrossGhoOut, ) = ghoGsm.getGhoAmountForSellAsset(
            stataSharesSold
        );
        if (assetSold != stataSharesSold || previewGrossGhoOut == 0) revert GsmQuoteMismatch();

        // Sell the exact static-aToken amount into GHO through the GSM.
        gsmStataToken.forceApprove(address(ghoGsm), stataSharesSold);
        (assetSold, ghoOut) = ghoGsm.sellAsset(stataSharesSold, recipient);
        gsmStataToken.forceApprove(address(ghoGsm), 0);

        // Require the live settlement to match the quoted asset amount and not under-deliver net GHO.
        if (assetSold != stataSharesSold || ghoOut < previewGhoOut) revert GsmSettlementMismatch();

        // Keep the gross pre-fee quote so entry accounting can normalize deployed value in vault-token units.
        grossGhoOut = previewGrossGhoOut;
    }

    /**
     * @dev Buys enough stata shares for a bounded GHO amount through the GSM buy path, then redeems
     *      only the requested share amount so the vault never observes an over-return.
     */
    function _buyVaultTokenWithGho(
        uint256 ghoAmount,
        uint256 stataTokenAmount,
        address recipient
    ) internal returns (uint256 vaultTokenOut) {
        // Quote how many static-aToken shares the GSM would deliver for this GHO budget.
        (uint256 stataTokenBought, uint256 quotedGhoSold, , ) = ghoGsm.getAssetAmountForBuyAsset(ghoAmount);
        if (stataTokenBought == 0 || quotedGhoSold == 0) revert GsmQuoteMismatch();

        // Bound the redeem amount so the vault never observes more vault token than requested.
        uint256 redeemShares = stataTokenBought < stataTokenAmount ? stataTokenBought : stataTokenAmount;
        if (redeemShares == 0) revert GsmQuoteMismatch();

        // Buy the bounded static-aToken amount with GHO.
        ghoToken.forceApprove(address(ghoGsm), ghoAmount);
        (uint256 actualStataBought, uint256 ghoSold) = ghoGsm.buyAsset(redeemShares, address(this));
        ghoToken.forceApprove(address(ghoGsm), 0);

        if (ghoSold > ghoAmount || actualStataBought < redeemShares) revert GsmSettlementMismatch();

        // Redeem the bought static-aToken shares back into the vault token.
        vaultTokenOut = gsmStataToken.redeem(redeemShares, recipient, address(this));
        if (vaultTokenOut == 0) revert GsmSettlementMismatch();
    }

    /**
     * @dev Quotes the wrapped-asset amount required to source up to `vaultTokenAmount` on the GSM
     *      buy path, bounded by the lane's current economic capacity.
     */
    function _quoteStataExitForVaultTokenAmount(
        uint256 vaultTokenAmount
    )
        internal
        view
        returns (
            uint256 economicVaultTokenCapacity,
            uint256 withdrawableVaultTokenCapacity,
            uint256 stataTokenAmountNeeded
        )
    {
        // Start from all stable-value GHO the lane can economically realize, including idle GHO and sGHO value.
        uint256 idleGho = ghoToken.balanceOf(address(this));
        uint256 economicGhoValue = idleGho + _sGhoValue();
        uint256 withdrawableGhoValue = idleGho + _sGhoWithdrawableValue();

        // For this stablecoin lane, GHO-side value is already the same accounting unit as vault-token value.
        economicVaultTokenCapacity = economicGhoValue;
        withdrawableVaultTokenCapacity = withdrawableGhoValue;

        // Size the static-aToken needed for the bounded vault-token target using the withdraw-side rounding path.
        uint256 vaultTokenTarget = vaultTokenAmount < economicVaultTokenCapacity
            ? vaultTokenAmount
            : economicVaultTokenCapacity;
        stataTokenAmountNeeded = gsmStataToken.previewWithdraw(vaultTokenTarget);
    }

    /**
     * @dev Returns the economic vault-token value of idle stata shares.
     */
    function _idleStataEconomicValue() internal view returns (uint256 assets) {
        uint256 shares = gsmStataToken.balanceOf(address(this));
        if (shares == 0) return 0;

        return gsmStataToken.previewRedeem(shares);
    }

    /**
     * @dev Returns the vault-token value withdrawable now from idle stata shares.
     */
    function _idleStataWithdrawableValue() internal view returns (uint256 assets) {
        uint256 shares = gsmStataToken.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 previewAssets = _idleStataEconomicValue();
        uint256 maxAssets = gsmStataToken.maxWithdraw(address(this));
        return previewAssets < maxAssets ? previewAssets : maxAssets;
    }

    /**
     * @dev Returns the economic GHO value of the current sGHO share balance using the ERC4626
     *      preview path. This ignores temporary liquidity constraints.
     */
    function _sGhoValue() internal view returns (uint256 assets) {
        uint256 shares = sGhoToken.balanceOf(address(this));
        if (shares == 0) return 0;

        return sGhoToken.previewRedeem(shares);
    }

    /**
     * @dev Returns the GHO value withdrawable now from the current sGHO share balance. This caps
     *      the ERC4626 preview value by `maxWithdraw()` so pauses and liquidity limits show up in
     *      `withdrawableExposure()`.
     */
    function _sGhoWithdrawableValue() internal view returns (uint256 assets) {
        uint256 shares = sGhoToken.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 previewAssets = _sGhoValue();
        uint256 maxAssets = sGhoToken.maxWithdraw(address(this));
        return previewAssets < maxAssets ? previewAssets : maxAssets;
    }

    /**
     * @dev Reverts on zero input for fund-moving entry points.
     */
    function _requireNonZero(uint256 amount) internal pure {
        if (amount == 0) revert ZeroAmount();
    }

    function _isWrappedGsmAssetForVaultToken(
        address expectedVaultToken,
        address gsmAsset
    ) internal view returns (bool) {
        if (gsmAsset == address(0)) return false;

        try IERC4626(gsmAsset).asset() returns (address assetToken) {
            if (assetToken != expectedVaultToken) return false;
        } catch {
            return false;
        }

        try IStataTokenV2(gsmAsset).aToken() returns (address aToken) {
            if (aToken == address(0)) return false;
            try IAaveV3AToken(aToken).UNDERLYING_ASSET_ADDRESS() returns (address underlyingAsset) {
                return underlyingAsset == expectedVaultToken;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function _requireExpectedGsmConfigAtInitialization(IAaveGsm gsm) internal view {
        address feeStrategy = gsm.getFeeStrategy();
        address priceStrategy = gsm.PRICE_STRATEGY();
        if (
            feeStrategy == address(0) ||
            priceStrategy == address(0) ||
            feeStrategy.code.length == 0 ||
            priceStrategy.code.length == 0
        ) {
            revert InvalidGsmConfig();
        }

        if (IAaveGsmFeeStrategy(feeStrategy).getSellFee(EXPECTED_GSM_PRICE_RATIO) != 0) {
            revert InvalidGsmConfig();
        }

        _requireExpectedGsmPriceRatio(gsm);
    }

    function _requireExpectedGsmPriceRatio(IAaveGsm gsm) internal view {
        address priceStrategy = gsm.PRICE_STRATEGY();
        if (priceStrategy == address(0) || priceStrategy.code.length == 0) revert InvalidGsmConfig();

        if (IAaveGsmPriceStrategy(priceStrategy).PRICE_RATIO() != EXPECTED_GSM_PRICE_RATIO) {
            revert InvalidGsmConfig();
        }
    }
}
