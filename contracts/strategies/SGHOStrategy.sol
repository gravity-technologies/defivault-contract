// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IAaveGsm} from "../external/IAaveGsm.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title SGHOStrategy
 * @notice Stateless vault-only strategy for the `vaultToken -> GSM -> GHO -> sGHO` lane.
 * @dev This lane separates economic exposure from operational liquidity:
 *      - `totalExposure()` reports the economic claim value of held `sGHO` shares.
 *      - `withdrawableExposure()` reports the currently redeemable subset of that claim.
 *      The strategy reverts if the `sGHO` leg cannot fully source the requested GHO amount for
 *      a tracked or harvest withdrawal.
 */
contract SGHOStrategy is Initializable, ReentrancyGuardUpgradeable, IYieldStrategyV2 {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();
    error InvalidSGhoConfig();
    error UnexpectedGsmExecution();
    error UnexpectedSGhoExecution();
    error InsufficientRedeemableLiquidity(uint256 requested, uint256 available);

    address public vault;
    address public override vaultToken;
    address public ghoToken;
    address public sGhoToken;
    address public gsmAdapter;
    string private _strategyName;

    uint256[50] private __gap;

    event Allocated(
        address indexed vaultToken,
        uint256 amountIn,
        uint256 invested,
        uint256 ghoOut,
        uint256 sGhoMinted
    );
    event Withdrawn(address indexed vaultToken, uint256 requested, uint256 received);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes one vault-token lane for the GSM -> sGHO strategy.
     * @dev Derives `ghoToken` from `IERC4626(sGho).asset()` and `vaultToken` from
     *      `gsm. UNDERLYING_ASSET()`. Reverts if the configured `sGHO` and GSM do not expose the
     *      expected `vaultToken <-> GHO <-> sGHO` route.
     */
    function initialize(
        address vault_,
        address sGho_,
        address gsm_,
        string calldata strategyName_
    ) external initializer {
        if (vault_ == address(0) || sGho_ == address(0) || gsm_ == address(0) || bytes(strategyName_).length == 0) {
            revert InvalidParam();
        }

        __ReentrancyGuard_init();

        if (gsm_.code.length == 0) revert InvalidParam();
        if (sGho_.code.length == 0) revert InvalidSGhoConfig();

        address derivedGhoToken;
        try IERC4626(sGho_).asset() returns (address assetToken) {
            if (assetToken == address(0)) revert InvalidSGhoConfig();
            derivedGhoToken = assetToken;
        } catch {
            revert InvalidSGhoConfig();
        }

        address derivedVaultToken = IAaveGsm(gsm_).UNDERLYING_ASSET();
        if (derivedVaultToken == address(0) || IAaveGsm(gsm_).GHO_TOKEN() != derivedGhoToken) {
            revert InvalidParam();
        }

        vault = vault_;
        vaultToken = derivedVaultToken;
        ghoToken = derivedGhoToken;
        sGhoToken = sGho_;
        gsmAdapter = gsm_;
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

    /// @notice Human-readable strategy identifier.
    function name() external view returns (string memory) {
        return _strategyName;
    }

    /// @inheritdoc IYieldStrategyV2
    function totalExposure() external view returns (uint256 exposure) {
        uint256 directVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 totalGhoAssets = IERC20(ghoToken).balanceOf(address(this)) + _economicGhoAssets();
        if (totalGhoAssets == 0) return directVaultToken;
        return directVaultToken + _vaultTokenValueForGho(totalGhoAssets);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawableExposure() external view returns (uint256 exposure) {
        uint256 directVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 totalGhoAssets = IERC20(ghoToken).balanceOf(address(this)) + _redeemableGhoAssets();
        if (totalGhoAssets == 0) return directVaultToken;
        return directVaultToken + _vaultTokenValueForGho(totalGhoAssets);
    }

    /// @inheritdoc IYieldStrategyV2
    function exactTokenBalance(address token) external view returns (uint256 amount) {
        if (token == vaultToken || token == ghoToken || token == sGhoToken) {
            return IERC20(token).balanceOf(address(this));
        }
        return 0;
    }

    /// @inheritdoc IYieldStrategyV2
    function tvlTokens() external view returns (address[] memory tokens) {
        tokens = new address[](3);
        tokens[0] = vaultToken;
        tokens[1] = ghoToken;
        tokens[2] = sGhoToken;
    }

    /// @inheritdoc IYieldStrategyV2
    function positionBreakdown() external view returns (PositionComponent[] memory components) {
        uint256 investedShares = IERC20(sGhoToken).balanceOf(address(this));
        uint256 directGho = IERC20(ghoToken).balanceOf(address(this));
        uint256 directVaultToken = IERC20(vaultToken).balanceOf(address(this));

        uint256 len = (investedShares == 0 ? 0 : 1) + (directGho == 0 ? 0 : 1) + (directVaultToken == 0 ? 0 : 1);
        if (len == 0) return components;

        components = new PositionComponent[](len);
        uint256 index;

        if (investedShares != 0) {
            components[index] = PositionComponent({
                token: sGhoToken,
                amount: investedShares,
                kind: PositionComponentKind.InvestedPosition
            });
            ++index;
        }
        if (directGho != 0) {
            components[index] = PositionComponent({
                token: ghoToken,
                amount: directGho,
                kind: PositionComponentKind.UninvestedToken
            });
            ++index;
        }
        if (directVaultToken != 0) {
            components[index] = PositionComponent({
                token: vaultToken,
                amount: directVaultToken,
                kind: PositionComponentKind.UninvestedToken
            });
        }
    }

    /// @inheritdoc IYieldStrategyV2
    function allocate(uint256 amount) external onlyVault nonReentrant returns (uint256 invested) {
        _requireNonZero(amount);

        IERC20(vaultToken).safeTransferFrom(vault, address(this), amount);
        (uint256 ghoOut, uint256 grossGhoOut) = _swapVaultTokenToGho(amount, address(this));

        IERC20(ghoToken).forceApprove(sGhoToken, ghoOut);
        uint256 sharesOut = IERC4626(sGhoToken).deposit(ghoOut, address(this));
        IERC20(ghoToken).forceApprove(sGhoToken, 0);
        if (sharesOut == 0) revert UnexpectedSGhoExecution();

        invested = _vaultTokenValueFromSellQuote(amount, grossGhoOut, ghoOut);
        if (invested > amount) revert UnexpectedGsmExecution();

        emit Allocated(vaultToken, amount, invested, ghoOut, sharesOut);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdraw(uint256 amount) external onlyVault nonReentrant returns (uint256 received) {
        _requireNonZero(amount);

        received = _sweepVaultTokenToVault(amount);
        if (received >= amount) {
            emit Withdrawn(vaultToken, amount, received);
            return received;
        }

        uint256 remaining = amount - received;
        (, uint256 ghoNeeded, , ) = IAaveGsm(gsmAdapter).getGhoAmountForBuyAsset(remaining);

        uint256 directGho = IERC20(ghoToken).balanceOf(address(this));
        uint256 ghoFromDirect = directGho < ghoNeeded ? directGho : ghoNeeded;
        uint256 ghoRemaining = ghoNeeded - ghoFromDirect;

        if (ghoRemaining != 0) {
            uint256 available = IERC4626(sGhoToken).maxWithdraw(address(this));
            if (available < ghoRemaining) revert InsufficientRedeemableLiquidity(ghoRemaining, available);

            uint256 beforeBalance = IERC20(ghoToken).balanceOf(address(this));
            uint256 sharesBurned = IERC4626(sGhoToken).withdraw(ghoRemaining, address(this), address(this));
            uint256 afterBalance = IERC20(ghoToken).balanceOf(address(this));
            if (sharesBurned == 0 || afterBalance < beforeBalance || afterBalance - beforeBalance != ghoRemaining) {
                revert UnexpectedSGhoExecution();
            }

            ghoFromDirect += ghoRemaining;
        }

        if (ghoFromDirect != 0) {
            received += _swapGhoToVaultToken(ghoFromDirect, remaining, vault);
        }

        emit Withdrawn(vaultToken, amount, received);
    }

    function _sweepVaultTokenToVault(uint256 maxAmount) internal returns (uint256 swept) {
        swept = IERC20(vaultToken).balanceOf(address(this));
        if (swept > maxAmount) swept = maxAmount;
        if (swept == 0) return 0;
        IERC20(vaultToken).safeTransfer(vault, swept);
    }

    function _swapVaultTokenToGho(
        uint256 vaultTokenAmount,
        address recipient
    ) internal returns (uint256 ghoOut, uint256 grossGhoOut) {
        (uint256 assetSold, uint256 previewGhoOut, uint256 previewGrossGhoOut, ) = IAaveGsm(gsmAdapter)
            .getGhoAmountForSellAsset(vaultTokenAmount);
        if (assetSold != vaultTokenAmount || previewGrossGhoOut == 0) revert UnexpectedGsmExecution();

        IERC20(vaultToken).forceApprove(gsmAdapter, vaultTokenAmount);
        (assetSold, ghoOut) = IAaveGsm(gsmAdapter).sellAsset(vaultTokenAmount, recipient);
        IERC20(vaultToken).forceApprove(gsmAdapter, 0);

        if (assetSold != vaultTokenAmount || ghoOut < previewGhoOut) revert UnexpectedGsmExecution();
        grossGhoOut = previewGrossGhoOut;
    }

    function _swapGhoToVaultToken(
        uint256 ghoAmount,
        uint256 expectedVaultTokenOut,
        address recipient
    ) internal returns (uint256 vaultTokenOut) {
        (, uint256 quotedGhoSold, , ) = IAaveGsm(gsmAdapter).getGhoAmountForBuyAsset(expectedVaultTokenOut);
        if (quotedGhoSold != ghoAmount) revert UnexpectedGsmExecution();

        IERC20(ghoToken).forceApprove(gsmAdapter, ghoAmount);
        (vaultTokenOut, quotedGhoSold) = IAaveGsm(gsmAdapter).buyAsset(expectedVaultTokenOut, recipient);
        IERC20(ghoToken).forceApprove(gsmAdapter, 0);

        if (quotedGhoSold != ghoAmount || vaultTokenOut != expectedVaultTokenOut) revert UnexpectedGsmExecution();
    }

    function _vaultTokenValueFromSellQuote(
        uint256 assetSold,
        uint256 grossGhoAmount,
        uint256 netGhoAmount
    ) internal pure returns (uint256 assets) {
        if (netGhoAmount == 0) return 0;
        if (assetSold == 0 || grossGhoAmount == 0) revert UnexpectedGsmExecution();
        assets = Math.mulDiv(assetSold, netGhoAmount, grossGhoAmount);
    }

    function _vaultTokenValueForGho(uint256 ghoAmount) internal view returns (uint256 assets) {
        if (ghoAmount == 0) return 0;
        uint256 assetSold;
        uint256 grossGho;
        (assetSold, , grossGho, ) = IAaveGsm(gsmAdapter).getAssetAmountForSellAsset(ghoAmount);
        if (assetSold == 0 || grossGho == 0) revert UnexpectedGsmExecution();
        assets = Math.mulDiv(assetSold, ghoAmount, grossGho);
    }

    function _economicGhoAssets() internal view returns (uint256 assets) {
        uint256 shares = IERC20(sGhoToken).balanceOf(address(this));
        if (shares == 0) return 0;

        return IERC4626(sGhoToken).previewRedeem(shares);
    }

    function _redeemableGhoAssets() internal view returns (uint256 assets) {
        uint256 shares = IERC20(sGhoToken).balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 previewAssets = _economicGhoAssets();
        uint256 maxAssets = IERC4626(sGhoToken).maxWithdraw(address(this));
        return previewAssets < maxAssets ? previewAssets : maxAssets;
    }

    function _requireNonZero(uint256 amount) internal pure {
        if (amount == 0) revert InvalidParam();
    }
}
