// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IAaveV3AToken} from "../external/IAaveV3AToken.sol";
import {IAaveV3Pool} from "../external/IAaveV3Pool.sol";
import {IYieldStrategyV2} from "../interfaces/IYieldStrategyV2.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title AaveV3StrategyV2
 * @notice Single-lane Aave V3 strategy that follows the V2 tracked/residual model.
 *
 * In plain terms:
 * - the vault sends one configured token into the strategy,
 * - the strategy supplies that token into Aave,
 * - the strategy holds the rebasing aToken position.
 *
 * The strategy keeps two buckets:
 * - tracked value: the part of the Aave position that still belongs to vault-funded allocation
 * - residual value: everything else, such as accrued yield, dust, or direct token transfers
 *
 * This strategy never requests treasury reimbursement, so `reimbursableFee` is always `0`.
 * It still exposes tracked and residual exits so the vault can use one shared V2 flow.
 */
contract AaveV3StrategyV2 is Initializable, ReentrancyGuardUpgradeable, IYieldStrategyV2 {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();
    error InvalidATokenConfig();
    error InvalidWithdraw();
    error UninvestedTokenAfterSupply(uint256 beforeBalance, uint256 afterBalance);

    /// @notice Vault that is allowed to move funds through this strategy.
    address public vault;
    /// @notice Single vault token lane supported by this deployment.
    address public override vaultToken;
    /// @notice Aave V3 pool used for supply and withdraw operations.
    IAaveV3Pool public aavePool;
    /// @notice Rebasing aToken held as the invested position.
    address public aToken;

    string private _strategyName;
    /// @notice Tracked vault-funded value still attributed to this strategy lane.
    uint256 private _trackedUnderlyingClaim;

    uint256[50] private __gap;

    event Allocated(address indexed vaultToken, uint256 amount);
    event Deallocated(address indexed vaultToken, uint256 requested, uint256 received, uint256 reimbursableFee);
    event UninvestedTokenSwept(address indexed vaultToken, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes one Aave lane.
     * @dev Reverts if the configured aToken does not match the pool and vault token.
     */
    function initialize(
        address vault_,
        address aavePool_,
        address vaultToken_,
        address aToken_,
        string calldata strategyName_
    ) external initializer {
        if (
            vault_ == address(0) ||
            aavePool_ == address(0) ||
            vaultToken_ == address(0) ||
            aToken_ == address(0) ||
            bytes(strategyName_).length == 0
        ) revert InvalidParam();

        __ReentrancyGuard_init();

        if (IAaveV3AToken(aToken_).UNDERLYING_ASSET_ADDRESS() != vaultToken_) revert InvalidATokenConfig();
        if (IAaveV3AToken(aToken_).POOL() != aavePool_) revert InvalidATokenConfig();

        vault = vault_;
        aavePool = IAaveV3Pool(aavePool_);
        vaultToken = vaultToken_;
        aToken = aToken_;
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
    function name() external view returns (string memory) {
        return _strategyName;
    }

    /// @inheritdoc IYieldStrategyV2
    function exactTokenBalance(address token) external view returns (uint256) {
        if (token == vaultToken || token == aToken) return IERC20(token).balanceOf(address(this));
        return 0;
    }

    /// @inheritdoc IYieldStrategyV2
    function tvlTokens() external view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = vaultToken;
        tokens[1] = aToken;
    }

    /// @inheritdoc IYieldStrategyV2
    function positionBreakdown() external view returns (PositionComponent[] memory components) {
        uint256 invested = IERC20(aToken).balanceOf(address(this));
        uint256 residual = IERC20(vaultToken).balanceOf(address(this));
        uint256 len = (invested == 0 ? 0 : 1) + (residual == 0 ? 0 : 1);
        if (len == 0) return components;

        components = new PositionComponent[](len);
        uint256 index;
        if (invested != 0) {
            components[index] = PositionComponent({
                token: aToken,
                amount: invested,
                kind: PositionComponentKind.InvestedPosition
            });
            ++index;
        }
        if (residual != 0) {
            components[index] = PositionComponent({
                token: vaultToken,
                amount: residual,
                kind: PositionComponentKind.UninvestedToken
            });
        }
    }

    /// @inheritdoc IYieldStrategyV2
    function strategyExposure() external view returns (uint256 exposure) {
        return IERC20(aToken).balanceOf(address(this)) + IERC20(vaultToken).balanceOf(address(this));
    }

    /// @inheritdoc IYieldStrategyV2
    function residualExposure() external view returns (uint256 exposure) {
        uint256 totalExposure = IERC20(aToken).balanceOf(address(this)) + IERC20(vaultToken).balanceOf(address(this));
        uint256 trackedClaim = _trackedUnderlyingClaim;
        if (totalExposure <= trackedClaim) return 0;
        return totalExposure - trackedClaim;
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Supplies fresh vault-token value into Aave and increases the tracked claim by `amount`.
     */
    function allocate(uint256 amount) external onlyVault nonReentrant {
        _requireNonZeroAmount(amount);

        uint256 beforeUnderlying = IERC20(vaultToken).balanceOf(address(this));
        IERC20(vaultToken).safeTransferFrom(vault, address(this), amount);
        IERC20(vaultToken).forceApprove(address(aavePool), amount);
        aavePool.supply(vaultToken, amount, address(this), 0);
        uint256 afterUnderlying = IERC20(vaultToken).balanceOf(address(this));
        if (afterUnderlying > beforeUnderlying) {
            revert UninvestedTokenAfterSupply(beforeUnderlying, afterUnderlying);
        }
        IERC20(vaultToken).forceApprove(address(aavePool), 0);

        _trackedUnderlyingClaim += amount;
        emit Allocated(vaultToken, amount);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawTracked(
        uint256 amount
    ) external onlyVault nonReentrant returns (uint256 received, uint256 reimbursableFee) {
        _requireNonZeroAmount(amount);

        uint256 trackedClaim = _trackedUnderlyingClaim;
        if (trackedClaim == 0) return (0, 0);

        uint256 requested = amount < trackedClaim ? amount : trackedClaim;
        uint256 invested = IERC20(aToken).balanceOf(address(this));
        uint256 withdrawAmount = requested < invested ? requested : invested;

        if (withdrawAmount != 0) {
            received = aavePool.withdraw(vaultToken, withdrawAmount, vault);
        }

        // Keep any unrecovered tracked claim in place if the invested position is impaired.
        if (received >= trackedClaim) {
            _trackedUnderlyingClaim = 0;
        } else if (received != 0) {
            _trackedUnderlyingClaim = trackedClaim - received;
        }

        emit Deallocated(vaultToken, amount, received, 0);
        return (received, 0);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawAllTracked() external onlyVault nonReentrant returns (uint256 received, uint256 reimbursableFee) {
        uint256 trackedClaim = _trackedUnderlyingClaim;
        if (trackedClaim == 0) return (0, 0);

        uint256 invested = IERC20(aToken).balanceOf(address(this));
        uint256 withdrawAmount = trackedClaim < invested ? trackedClaim : invested;
        if (withdrawAmount != 0) {
            received = aavePool.withdraw(vaultToken, withdrawAmount, vault);
        }

        if (received >= trackedClaim) {
            _trackedUnderlyingClaim = 0;
        } else if (received != 0) {
            _trackedUnderlyingClaim = trackedClaim - received;
        }
        emit Deallocated(vaultToken, type(uint256).max, received, 0);
        return (received, 0);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawResidual(uint256 amount) external onlyVault nonReentrant returns (uint256 received) {
        _requireNonZeroAmount(amount);

        received = _sweepUninvestedTokenToVaultUpTo(amount);
        if (received >= amount) {
            emit Deallocated(vaultToken, amount, received, 0);
            return received;
        }

        uint256 remaining = amount - received;
        uint256 investedResidual = _investedResidualExposure();
        if (investedResidual != 0) {
            uint256 withdrawAmount = remaining < investedResidual ? remaining : investedResidual;
            received += aavePool.withdraw(vaultToken, withdrawAmount, vault);
        }

        emit Deallocated(vaultToken, amount, received, 0);
    }

    /// @inheritdoc IYieldStrategyV2
    function withdrawAllResidual() external onlyVault nonReentrant returns (uint256 received) {
        received = _sweepUninvestedTokenToVaultUpTo(type(uint256).max);

        uint256 investedResidual = _investedResidualExposure();
        if (investedResidual != 0) {
            received += aavePool.withdraw(vaultToken, investedResidual, vault);
        }

        emit Deallocated(vaultToken, type(uint256).max, received, 0);
    }

    /**
     * @notice Returns the residual slice currently sitting inside the Aave invested position.
     * @dev Direct vault-token balance is handled separately through `_sweepUninvestedTokenToVaultUpTo`.
     */
    function _investedResidualExposure() internal view returns (uint256 residual) {
        uint256 invested = IERC20(aToken).balanceOf(address(this));
        uint256 trackedClaim = _trackedUnderlyingClaim;
        if (invested <= trackedClaim) return 0;
        return invested - trackedClaim;
    }

    /**
     * @notice Sweeps idle vault token back to the vault, up to `maxAmount`.
     */
    function _sweepUninvestedTokenToVaultUpTo(uint256 maxAmount) internal returns (uint256 swept) {
        swept = IERC20(vaultToken).balanceOf(address(this));
        if (swept > maxAmount) swept = maxAmount;
        if (swept == 0) return 0;

        IERC20(vaultToken).safeTransfer(vault, swept);
        emit UninvestedTokenSwept(vaultToken, swept);
    }

    function _requireNonZeroAmount(uint256 amount) internal pure {
        if (amount == 0) revert InvalidParam();
    }
}
