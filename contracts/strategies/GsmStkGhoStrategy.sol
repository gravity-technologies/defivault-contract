// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IMerklDistributor} from "../external/IMerklDistributor.sol";
import {IAaveGsm} from "../external/IAaveGsm.sol";
import {IStkGhoStaking} from "../external/IStkGhoStaking.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title GsmStkGhoStrategy
 * @notice Stateless vault-only strategy for moving one stablecoin lane into `stkGHO`.
 *
 * This lane follows one fixed internal route:
 * - vault token -> GSM sell -> GHO -> staking adapter -> stkGHO
 * - exit reverses that path: stkGHO -> unstake -> GHO -> GSM buy -> vault token
 *
 * The strategy holds **zero** tracked-principal state. All accounting (cost basis, residual
 * computation, fee inference, reimbursement) is owned by the vault.
 *
 * `totalExposure()` reports **gross** vault-token-equivalent using the GSM sell-side preview
 * (not the buy-side net), so the vault's `residual = totalExposure - costBasis` captures
 * yield appreciation without baking in hypothetical exit fees.
 */
contract GsmStkGhoStrategy is Initializable, ReentrancyGuardUpgradeable, IYieldStrategyV2 {
    using SafeERC20 for IERC20;

    /// @dev Caller is not the configured vault.
    error Unauthorized();
    /// @dev Input address or amount is zero, unsupported, or otherwise malformed for this lane.
    error InvalidParam();
    /// @dev Configured staking adapter does not match the expected `GHO <-> stkGHO` pair.
    error InvalidStkGhoStakingConfig();
    /// @dev GSM quote or execution did not consume the full expected notional for this lane.
    error UnexpectedGsmExecution();

    /// @notice Vault that is allowed to move funds through this strategy.
    address public vault;
    /// @notice Single vault token supported by this deployment.
    address public override vaultToken;
    /// @notice GHO token used as the middle step between the vault token and `stkGHO`.
    address public ghoToken;
    /// @notice Staked GHO token held as the invested position.
    address public stkGhoToken;
    /// @notice GSM adapter used for `vaultToken <-> GHO` swaps.
    address public gsmAdapter;
    /// @notice Staking adapter used for `GHO <-> stkGHO` conversion.
    address public stkGhoStakingAdapter;
    /// @notice Angle rewards distributor used for permissionless stkGHO claims.
    address public stkGhoRewardsDistributor;
    string private _strategyName;

    uint256[50] private __gap;

    /// @notice Emitted after a successful full allocate path into stkGHO.
    event Allocated(
        address indexed vaultToken,
        uint256 amountIn,
        uint256 invested,
        uint256 ghoOut,
        uint256 stkGhoStaked
    );
    /// @notice Emitted after any withdrawal path returns funds to the vault.
    event Withdrawn(address indexed vaultToken, uint256 requested, uint256 received);
    /// @notice Emitted when the rewards distributor is fixed during initialization.
    event RewardsDistributorInitialized(address indexed distributor);
    /// @notice Emitted when stkGHO rewards are claimed directly into the strategy.
    event RewardsClaimed(address indexed caller, uint256 claimedDelta, uint256 cumulativeAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes one vault-token lane for the GSM -> stkGHO strategy.
     * @dev Reverts if any address is zero, the name is empty, or the configured staking adapter does not
     *      expose the expected `ghoToken <-> stkGhoToken` pair.
     */
    function initialize(
        address vault_,
        address vaultToken_,
        address gho_,
        address stkGho_,
        address gsm_,
        address stkGhoStakingAdapter_,
        address stkGhoRewardsDistributor_,
        string calldata strategyName_
    ) external initializer {
        if (
            vault_ == address(0) ||
            vaultToken_ == address(0) ||
            gho_ == address(0) ||
            stkGho_ == address(0) ||
            gsm_ == address(0) ||
            stkGhoStakingAdapter_ == address(0) ||
            stkGhoRewardsDistributor_ == address(0) ||
            bytes(strategyName_).length == 0
        ) revert InvalidParam();

        __ReentrancyGuard_init();

        if (IAaveGsm(gsm_).GHO_TOKEN() != gho_) revert InvalidParam();
        if (IAaveGsm(gsm_).UNDERLYING_ASSET() != vaultToken_) revert InvalidParam();
        if (stkGhoStakingAdapter_.code.length == 0) revert InvalidStkGhoStakingConfig();
        try IStkGhoStaking(stkGhoStakingAdapter_).gho() returns (address stakingGho) {
            if (stakingGho != gho_) revert InvalidStkGhoStakingConfig();
        } catch {
            revert InvalidStkGhoStakingConfig();
        }
        try IStkGhoStaking(stkGhoStakingAdapter_).stkGho() returns (address stakingStkGho) {
            if (stakingStkGho != stkGho_) revert InvalidStkGhoStakingConfig();
        } catch {
            revert InvalidStkGhoStakingConfig();
        }
        if (stkGhoRewardsDistributor_.code.length == 0) revert InvalidParam();

        vault = vault_;
        vaultToken = vaultToken_;
        ghoToken = gho_;
        stkGhoToken = stkGho_;
        gsmAdapter = gsm_;
        stkGhoStakingAdapter = stkGhoStakingAdapter_;
        stkGhoRewardsDistributor = stkGhoRewardsDistributor_;
        _strategyName = strategyName_;

        emit RewardsDistributorInitialized(stkGhoRewardsDistributor_);
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    // --------- Identity / marker ---------

    /// @inheritdoc IYieldStrategyV2
    function isYieldStrategyV2() external pure returns (bytes4) {
        return IYieldStrategyV2.isYieldStrategyV2.selector;
    }

    /// @notice Human-readable strategy identifier.
    function name() external view returns (string memory) {
        return _strategyName;
    }

    // --------- Reporting ---------

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Reports **gross** vault-token equivalent using the GSM sell-side preview.
     *      `getAssetAmountForSellAsset(ghoAmount)` returns the vault-token amount that would have
     *      produced `ghoAmount` GHO, without deducting the buy-side exit fee.
     */
    function totalExposure() external view returns (uint256 exposure) {
        uint256 directVaultToken = IERC20(vaultToken).balanceOf(address(this));
        uint256 grossGhoAssets = _totalGhoAssets();
        if (grossGhoAssets == 0) return directVaultToken;
        (uint256 grossVaultToken, , , ) = IAaveGsm(gsmAdapter).getAssetAmountForSellAsset(grossGhoAssets);
        return directVaultToken + grossVaultToken;
    }

    /// @inheritdoc IYieldStrategyV2
    function exactTokenBalance(address token) external view returns (uint256) {
        if (token == vaultToken || token == ghoToken || token == stkGhoToken) {
            return IERC20(token).balanceOf(address(this));
        }
        return 0;
    }

    /// @inheritdoc IYieldStrategyV2
    function tvlTokens() external view returns (address[] memory tokens) {
        tokens = new address[](3);
        tokens[0] = vaultToken;
        tokens[1] = ghoToken;
        tokens[2] = stkGhoToken;
    }

    /// @inheritdoc IYieldStrategyV2
    function positionBreakdown() external view returns (PositionComponent[] memory components) {
        uint256 invested = IERC20(stkGhoToken).balanceOf(address(this));
        uint256 directGho = IERC20(ghoToken).balanceOf(address(this));
        uint256 directVaultToken = IERC20(vaultToken).balanceOf(address(this));

        uint256 len = (invested == 0 ? 0 : 1) + (directGho == 0 ? 0 : 1) + (directVaultToken == 0 ? 0 : 1);
        if (len == 0) return components;

        components = new PositionComponent[](len);
        uint256 index;

        if (invested != 0) {
            components[index] = PositionComponent({
                token: stkGhoToken,
                amount: invested,
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

    // --------- Fund movements ---------

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Pulls `amount` vault-token from the vault, swaps to GHO via GSM, stakes as stkGHO.
     *      Returns `invested`: the net vault-token-equivalent of the GHO actually staked.
     *      If entry (GSM sell) fee is zero, `invested = amount`.
     */
    function allocate(uint256 amount) external onlyVault nonReentrant returns (uint256 invested) {
        _requireNonZero(amount);

        IERC20(vaultToken).safeTransferFrom(vault, address(this), amount);
        uint256 ghoOut = _swapVaultTokenToGho(amount, address(this));

        IERC20(ghoToken).forceApprove(stkGhoStakingAdapter, ghoOut);
        uint256 stkGhoOut = IStkGhoStaking(stkGhoStakingAdapter).deposit(ghoOut, address(this));
        IERC20(ghoToken).forceApprove(stkGhoStakingAdapter, 0);

        invested = _netVaultTokenEquivalentForNetGho(ghoOut);
        if (invested > amount) invested = amount;

        emit Allocated(vaultToken, amount, invested, ghoOut, stkGhoOut);
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Withdraws `amount` of gross vault-token-equivalent exposure. Converts the corresponding
     *      GHO amount from stkGHO back through the GSM. Returns actual vault-token sent to vault
     *      (net of GSM buy-side exit fee).
     */
    function withdraw(uint256 amount) external onlyVault nonReentrant returns (uint256 received) {
        _requireNonZero(amount);

        // First sweep idle vault-token
        received = _sweepVaultTokenToVault(amount);
        if (received >= amount) {
            emit Withdrawn(vaultToken, amount, received);
            return received;
        }

        uint256 remaining = amount - received;

        // Convert remaining gross vault-token amount to GHO equivalent
        (, uint256 ghoNeeded, , ) = IAaveGsm(gsmAdapter).getGhoAmountForSellAsset(remaining);

        // Sweep idle GHO first
        uint256 directGho = IERC20(ghoToken).balanceOf(address(this));
        uint256 ghoFromDirect = directGho < ghoNeeded ? directGho : ghoNeeded;
        uint256 ghoRemaining = ghoNeeded - ghoFromDirect;

        // Unstake stkGHO for the rest
        if (ghoRemaining != 0) {
            uint256 sharesToBurn = IStkGhoStaking(stkGhoStakingAdapter).previewWithdraw(ghoRemaining);
            uint256 totalShares = IERC20(stkGhoToken).balanceOf(address(this));
            if (sharesToBurn > totalShares) sharesToBurn = totalShares;
            if (sharesToBurn != 0) {
                uint256 unstakedGho = _unstakeGho(sharesToBurn);
                ghoFromDirect += unstakedGho;
            }
        }

        // Swap all collected GHO to vault-token via GSM buy path
        uint256 ghoToSwap = ghoFromDirect < ghoNeeded ? ghoFromDirect : ghoNeeded;
        if (ghoToSwap != 0) {
            received += _swapGhoToVaultToken(ghoToSwap, vault);
        }

        emit Withdrawn(vaultToken, amount, received);
    }

    /**
     * @notice Claims stkGHO rewards against the strategy itself.
     * @dev Rewards stay as residual exposure (no tracked state to update).
     */
    function claimStkGhoRewards(
        uint256 cumulativeRewardAmount,
        bytes32[] calldata proofs
    ) external nonReentrant returns (uint256 claimedDelta) {
        if (cumulativeRewardAmount == 0) revert InvalidParam();
        address distributor = stkGhoRewardsDistributor;
        if (distributor == address(0) || distributor.code.length == 0) revert InvalidParam();

        uint256 beforeBalance = IERC20(stkGhoToken).balanceOf(address(this));
        address[] memory users = new address[](1);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        bytes32[][] memory proofSets = new bytes32[][](1);
        users[0] = address(this);
        tokens[0] = stkGhoToken;
        amounts[0] = cumulativeRewardAmount;
        proofSets[0] = proofs;

        IMerklDistributor(distributor).claim(users, tokens, amounts, proofSets);

        claimedDelta = IERC20(stkGhoToken).balanceOf(address(this)) - beforeBalance;
        if (claimedDelta == 0) revert InvalidParam();

        emit RewardsClaimed(msg.sender, claimedDelta, cumulativeRewardAmount);
    }

    // --------- Internal helpers ---------

    /**
     * @notice Sweeps idle vault token back to the vault, up to `maxAmount`.
     */
    function _sweepVaultTokenToVault(uint256 maxAmount) internal returns (uint256 swept) {
        swept = IERC20(vaultToken).balanceOf(address(this));
        if (swept > maxAmount) swept = maxAmount;
        if (swept == 0) return 0;
        IERC20(vaultToken).safeTransfer(vault, swept);
    }

    /**
     * @notice Swaps vault token into GHO through GSM sell path.
     * @dev Requires GSM to consume the full requested vault-token amount.
     */
    function _swapVaultTokenToGho(uint256 vaultTokenAmount, address recipient) internal returns (uint256 ghoOut) {
        (uint256 assetSold, uint256 previewGhoOut, , ) = IAaveGsm(gsmAdapter).getGhoAmountForSellAsset(
            vaultTokenAmount
        );
        if (assetSold != vaultTokenAmount) revert UnexpectedGsmExecution();
        IERC20(vaultToken).forceApprove(gsmAdapter, vaultTokenAmount);
        (assetSold, ghoOut) = IAaveGsm(gsmAdapter).sellAsset(vaultTokenAmount, recipient);
        IERC20(vaultToken).forceApprove(gsmAdapter, 0);
        if (assetSold != vaultTokenAmount || ghoOut < previewGhoOut) revert UnexpectedGsmExecution();
    }

    /**
     * @notice Swaps GHO back into the vault token through GSM buy path.
     * @dev Requires the GSM to consume the full requested GHO notional.
     */
    function _swapGhoToVaultToken(uint256 ghoAmount, address recipient) internal returns (uint256 vaultTokenOut) {
        (uint256 minAssetOut, uint256 ghoSold, , ) = IAaveGsm(gsmAdapter).getAssetAmountForBuyAsset(ghoAmount);
        if (ghoSold != ghoAmount) revert UnexpectedGsmExecution();
        IERC20(ghoToken).forceApprove(gsmAdapter, ghoSold);
        (vaultTokenOut, ghoSold) = IAaveGsm(gsmAdapter).buyAsset(minAssetOut, recipient);
        IERC20(ghoToken).forceApprove(gsmAdapter, 0);
        if (ghoSold != ghoAmount) revert UnexpectedGsmExecution();
    }

    /**
     * @notice Unstakes stkGHO shares back into GHO.
     */
    function _unstakeGho(uint256 stkGhoShares) internal returns (uint256 assets) {
        if (stkGhoShares == 0) return 0;
        IERC20(stkGhoToken).forceApprove(stkGhoStakingAdapter, stkGhoShares);
        assets = IStkGhoStaking(stkGhoStakingAdapter).redeem(stkGhoShares, address(this), address(this));
        IERC20(stkGhoToken).forceApprove(stkGhoStakingAdapter, 0);
    }

    /**
     * @notice Returns the net vault-token-equivalent of an already-realized net GHO amount.
     * @dev This inverts the GSM sell path on the actual `ghoBought` output, so V2 `invested`
     *      reflects net deployed value rather than the original gross vault-token input.
     */
    function _netVaultTokenEquivalentForNetGho(uint256 netGhoAmount) internal view returns (uint256 assets) {
        if (netGhoAmount == 0) return 0;
        uint256 ghoBought;
        (assets, ghoBought, , ) = IAaveGsm(gsmAdapter).getAssetAmountForSellAsset(netGhoAmount);
        if (ghoBought < netGhoAmount) revert UnexpectedGsmExecution();
    }

    /**
     * @notice Returns the full GHO-equivalent asset value currently held by the strategy.
     */
    function _totalGhoAssets() internal view returns (uint256 totalAssets) {
        uint256 totalShares = IERC20(stkGhoToken).balanceOf(address(this));
        totalAssets = IERC20(ghoToken).balanceOf(address(this));
        if (totalShares != 0) totalAssets += IStkGhoStaking(stkGhoStakingAdapter).convertToAssets(totalShares);
    }

    function _requireNonZero(uint256 amount) internal pure {
        if (amount == 0) revert InvalidParam();
    }
}
