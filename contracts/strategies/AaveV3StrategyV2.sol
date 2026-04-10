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
 * @notice Stateless single-lane Aave V3 strategy for the V2 interface.
 *
 * This is a zero-fee DirectWrapper baseline:
 * - vault token -> Aave supply -> aToken
 * - aToken -> Aave withdraw -> vault token
 *
 * The strategy holds **zero** tracked-principal state. All accounting (cost basis,
 * residual computation, fee inference) is owned by the vault.
 */
contract AaveV3StrategyV2 is Initializable, ReentrancyGuardUpgradeable, IYieldStrategyV2 {
    using SafeERC20 for IERC20;

    /// @dev Caller is not the configured vault.
    error Unauthorized();
    /// @dev Input address or amount is zero or otherwise malformed for this lane.
    error InvalidParam();
    /// @dev Provided aToken does not match the configured underlying token or Aave pool.
    error InvalidATokenConfig();

    /// @notice Vault that is allowed to move funds through this strategy.
    address public vault;
    /// @notice Single vault token lane supported by this deployment.
    address public override vaultToken;
    /// @notice Aave V3 pool used for supply and withdraw operations.
    IAaveV3Pool public aavePool;
    /// @notice Rebasing aToken held as the invested position.
    address public aToken;

    string private _strategyName;

    uint256[50] private __gap;

    /// @notice Emitted after underlying is supplied into Aave for this lane.
    event Allocated(address indexed vaultToken, uint256 amount, uint256 invested);
    /// @notice Emitted after value is withdrawn back to the vault.
    event Withdrawn(address indexed vaultToken, uint256 requested, uint256 received);

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

    /// @inheritdoc IYieldStrategyV2
    function totalExposure() external view returns (uint256 exposure) {
        return IERC20(aToken).balanceOf(address(this)) + IERC20(vaultToken).balanceOf(address(this));
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
        uint256 direct = IERC20(vaultToken).balanceOf(address(this));
        uint256 len = (invested == 0 ? 0 : 1) + (direct == 0 ? 0 : 1);
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
        if (direct != 0) {
            components[index] = PositionComponent({
                token: vaultToken,
                amount: direct,
                kind: PositionComponentKind.UninvestedToken
            });
        }
    }

    // --------- Fund movements ---------

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Supplies vault-token into Aave. For this zero-fee lane, `invested = amount`.
     */
    function allocate(uint256 amount) external onlyVault nonReentrant returns (uint256 invested) {
        _requireNonZero(amount);

        IERC20(vaultToken).safeTransferFrom(vault, address(this), amount);
        IERC20(vaultToken).forceApprove(address(aavePool), amount);
        aavePool.supply(vaultToken, amount, address(this), 0);
        IERC20(vaultToken).forceApprove(address(aavePool), 0);

        invested = amount; // zero-fee lane
        emit Allocated(vaultToken, amount, invested);
    }

    /**
     * @inheritdoc IYieldStrategyV2
     * @dev Withdraws `amount` of reported strategy value from Aave and sends to vault.
     *      For this zero-fee lane, `received ≈ amount` (Aave may return slightly less
     *      if the available liquidity is constrained).
     */
    function withdraw(uint256 amount) external onlyVault nonReentrant returns (uint256 received) {
        _requireNonZero(amount);

        // First sweep any idle vault-token (direct underlying)
        uint256 direct = IERC20(vaultToken).balanceOf(address(this));
        uint256 directSweep = direct < amount ? direct : amount;
        if (directSweep != 0) {
            IERC20(vaultToken).safeTransfer(vault, directSweep);
            received = directSweep;
        }

        // Then withdraw from Aave for the remainder
        uint256 remaining = amount - directSweep;
        if (remaining != 0) {
            uint256 aTokenBal = IERC20(aToken).balanceOf(address(this));
            uint256 withdrawAmount = remaining < aTokenBal ? remaining : aTokenBal;
            if (withdrawAmount != 0) {
                uint256 beforeBal = IERC20(vaultToken).balanceOf(vault);
                aavePool.withdraw(vaultToken, withdrawAmount, vault);
                uint256 afterBal = IERC20(vaultToken).balanceOf(vault);
                received += afterBal - beforeBal;
            }
        }

        emit Withdrawn(vaultToken, amount, received);
    }

    /// @notice Rejects zero-amount requests.
    function _requireNonZero(uint256 amount) internal pure {
        if (amount == 0) revert InvalidParam();
    }
}
