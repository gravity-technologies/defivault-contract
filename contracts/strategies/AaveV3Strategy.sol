// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IAaveV3AToken} from "../external/IAaveV3AToken.sol";
import {IAaveV3Pool} from "../external/IAaveV3Pool.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {
    StrategyAssetBreakdown,
    TokenAmountComponent,
    TokenAmountComponentKind
} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title AaveV3Strategy
 * @notice IYieldStrategy implementation that supplies a single ERC20 token to an Aave V3 pool
 *         and holds the resulting aTokens on behalf of GRVTDeFiVault.
 *
 * @dev ## Design constraints
 *
 *      ### Single-token per deployment
 *      Each instance is bound to one (`underlying`, `aToken`, `aavePool`) triple set at
 *      initialization. `allocate` and `deallocate` revert on a token mismatch. Deploy separate
 *      strategy instances for each token/pool combination.
 *
 *      ### aToken configuration validation
 *      `initialize` cross-checks the provided `aToken_` against the Aave pool by calling
 *      `IAaveV3AToken.UNDERLYING_ASSET_ADDRESS()` and `IAaveV3AToken.POOL()`. Misconfigured
 *      aToken addresses (e.g. wrong asset or wrong pool) revert with `InvalidATokenConfig`
 *      at init time rather than silently producing incorrect TVL accounting.
 *
 *      ### assets() reporting shape
 *      `assets(token)` returns structured exact-token components:
 *      - for `token == underlying`: report `aToken` invested principal + `underlying` residual
 *      - for `token == aToken`: report `aToken` invested principal only
 *      - for unsupported tokens: return `components.length == 0` (non-reverting)
 *
 *      The aToken balance accrues yield continuously (Aave's rebasing mechanism).
 *      The underlying balance is normally near-zero between calls, but residual dust can exist.
 *
 *      ### Scalar assumption (USDT deployment)
 *      For the USDT/aUSDT deployment, this adapter explicitly assumes `1 USDT == 1 aUSDT`
 *      for the `principalBearingExposure(USDT)` scalar path. This simplifies vault-side
 *      cap/harvest/exposure math by avoiding index-based conversion logic in this scope.
 *
 *      Implications:
 *      - TVL reporting is still exact-token and assumption-free: `assets(token)` returns
 *        separate `TokenAmountComponent` entries (aUSDT and residual USDT) and does not merge
 *        or convert denominations.
 *      - `allocate` / `deallocate` / `deallocateAll` remain exact ERC20 operations against Aave
 *        supply/withdraw flows; they do not rely on this scalar assumption for token movement.
 *      - If aUSDT-to-USDT deviates from 1:1, scalar-based vault decisions can drift from economic
 *        value. Drift affects control decisions, not token accounting:
 *          - scalar too high: cap can block allocation early; harvest can over-request and revert
 *            on vault-side measured bounds (`YieldNotAvailable` in vault path).
 *          - scalar too low: cap can allow excess allocation; harvest can under-extract yield.
 *          - loss recognition timing can shift because principal write-down uses scalar exposure.
 *      - Even under scalar drift, exact-token reporting (`assets`) and actual transfer outcomes
 *        remain denomination-correct because vault measures real balance deltas on unwind.
 *
 *      ### allocate / deallocate flow
 *      - `allocate`:  pull `amount` from vault → approve pool → `pool.supply` → reset approval.
 *        aTokens land in this strategy contract (not the vault).
 *      - `deallocate`: call `pool.withdraw(token, amount, vault)`. Aave transfers underlying
 *        directly to the vault, bypassing this contract. The strategy does not hold underlying
 *        during this path.
 *      - `deallocateAll`: identical to `deallocate` but passes `type(uint256).max` to Aave,
 *        which Aave interprets as "withdraw full aToken balance".
 *
 *      ### Return value trust
 *      `deallocate` and `deallocateAll` return total value delivered to vault:
 *        Aave-withdrawn amount + residual-underlying sweep amount.
 *      GRVTDeFiVault independently measures the balance delta on its end and emits
 *      `StrategyReportedReceivedMismatch` on discrepancy.
 *
 *      ### Authorization
 *      All mutating functions (`allocate`, `deallocate`, `deallocateAll`) are restricted to
 *      `vault` via `onlyVault`. View functions have no access control.
 *
 *      ### Upgrade safety
 *      A `__gap` array reserves storage slots for future layout additions without
 *      colliding with proxy storage.
 */
contract AaveV3Strategy is Initializable, ReentrancyGuardUpgradeable, IYieldStrategy {
    // ============================================= Constants ======================================================
    using SafeERC20 for IERC20;

    // ============================================= Storage (Public/Private) =======================================

    /// @notice The vault contract that is the sole authorized caller of mutating functions.
    address public vault;

    /// @notice The Aave V3 pool used for supply and withdraw operations.
    IAaveV3Pool public aavePool;

    /// @notice The underlying ERC20 token this strategy accepts (e.g. USDC, USDT).
    address public underlying;

    /// @notice The Aave aToken received in exchange for supplying `underlying` (e.g. aUSDC).
    /// @dev Held by this strategy contract; balance accrues interest continuously via rebasing.
    address public aToken;

    /// @dev Human-readable strategy identifier returned by `name()` (e.g. "AAVE_V3_USDC").
    string private _strategyName;

    /// @dev Reserved storage gap for future upgrade-safe layout additions.
    uint256[50] private __gap;

    // =============================================== Errors ===================================================

    /// @dev Thrown by `onlyVault` when msg.sender is not the configured `vault`.
    error Unauthorized();

    /// @dev Thrown when a zero address, zero amount, or wrong token is passed to a mutating function.
    error InvalidParam();

    /// @dev Thrown during `initialize` if `aToken_` does not correspond to `underlying_` and `aavePool_`
    ///      according to the aToken's own `UNDERLYING_ASSET_ADDRESS()` and `POOL()` getters.
    error InvalidATokenConfig();

    /// @dev Thrown by `allocate` when underlying balance after `supply` exceeds the pre-call balance.
    ///      This indicates supply did not consume all newly pulled funds.
    error ResidualUnderlyingAfterSupply(uint256 beforeBalance, uint256 afterBalance);

    // =============================================== Events ===================================================

    /**
     * @notice Emitted after a successful `allocate` call.
     * @param token  The underlying token supplied to Aave.
     * @param amount The amount supplied.
     */
    event Allocated(address indexed token, uint256 amount);

    /**
     * @notice Emitted after a successful `deallocate` or `deallocateAll` call.
     * @param token     The underlying token withdrawn from Aave.
     * @param requested The amount requested (`type(uint256).max` for `deallocateAll`).
     * @param received  Total amount delivered to vault (Aave withdraw + residual-underlying sweep).
     */
    event Deallocated(address indexed token, uint256 requested, uint256 received);

    /**
     * @notice Emitted when residual underlying held by this strategy is swept to vault.
     * @param token  The underlying token swept.
     * @param amount Amount transferred to vault.
     */
    event ResidualUnderlyingSwept(address indexed token, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable strategy.
     * @dev Validates the (`aToken_`, `underlying_`, `aavePool_`) triple by calling
     *      `IAaveV3AToken.UNDERLYING_ASSET_ADDRESS()` and `IAaveV3AToken.POOL()` on `aToken_`.
     *      Reverts with `InvalidATokenConfig` if either check fails, preventing silent
     *      misconfiguration that would corrupt vault TVL accounting.
     * @param vault_        Vault address authorized to call mutating functions. Must be non-zero.
     * @param aavePool_     Aave V3 pool address. Must be non-zero and match `aToken_`.
     * @param underlying_   Underlying ERC20 token address. Must be non-zero and match `aToken_`.
     * @param aToken_       Aave aToken address corresponding to `underlying_` in `aavePool_`. Must be non-zero.
     * @param strategyName_ Human-readable strategy name (e.g. "AAVE_V3_USDC"). Must be non-empty.
     */
    function initialize(
        address vault_,
        address aavePool_,
        address underlying_,
        address aToken_,
        string calldata strategyName_
    ) external initializer {
        if (
            vault_ == address(0) ||
            aavePool_ == address(0) ||
            underlying_ == address(0) ||
            aToken_ == address(0) ||
            bytes(strategyName_).length == 0
        ) revert InvalidParam();

        __ReentrancyGuard_init();

        if (IAaveV3AToken(aToken_).UNDERLYING_ASSET_ADDRESS() != underlying_) revert InvalidATokenConfig();
        if (IAaveV3AToken(aToken_).POOL() != aavePool_) revert InvalidATokenConfig();

        vault = vault_;
        aavePool = IAaveV3Pool(aavePool_);
        underlying = underlying_;
        aToken = aToken_;
        _strategyName = strategyName_;
    }

    /// @dev Reverts if msg.sender is not the configured `vault`.
    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    /// @inheritdoc IYieldStrategy
    function name() external view override returns (string memory) {
        return _strategyName;
    }

    /**
     * @inheritdoc IYieldStrategy
     * @dev Structured exact-token reporting:
     *      - `token == underlying`: reports up to two components:
     *          1. `aToken` (InvestedPrincipal)
     *          2. `underlying` (ResidualUnderlying)
     *      - `token == aToken`: reports `aToken` (InvestedPrincipal) only.
     *      - otherwise: returns empty components (unsupported token path).
     */
    function assets(address token) external view override returns (StrategyAssetBreakdown memory breakdown) {
        if (token != underlying && token != aToken) return breakdown;

        uint256 invested = IERC20(aToken).balanceOf(address(this));
        if (token == aToken) {
            if (invested == 0) return breakdown;
            breakdown.components = new TokenAmountComponent[](1);
            breakdown.components[0] = TokenAmountComponent({
                token: aToken,
                amount: invested,
                kind: TokenAmountComponentKind.InvestedPrincipal
            });
            return breakdown;
        }

        uint256 residual = IERC20(underlying).balanceOf(address(this));
        uint256 len = (invested == 0 ? 0 : 1) + (residual == 0 ? 0 : 1);
        if (len == 0) return breakdown;

        breakdown.components = new TokenAmountComponent[](len);
        uint256 index;
        if (invested != 0) {
            breakdown.components[index] = TokenAmountComponent({
                token: aToken,
                amount: invested,
                kind: TokenAmountComponentKind.InvestedPrincipal
            });
            ++index;
        }
        if (residual != 0) {
            breakdown.components[index] = TokenAmountComponent({
                token: underlying,
                amount: residual,
                kind: TokenAmountComponentKind.ResidualUnderlying
            });
        }
        return breakdown;
    }

    /**
     * @inheritdoc IYieldStrategy
     * @dev Aave scalar policy for this adapter:
     *      - supported domain: `token == underlying`
     *      - scalar: `aTokenBalance + underlyingResidual`
     *      - explicit assumption (for scalar path only): `1 aToken == 1 underlying`
     *
     *      Unsupported token queries return 0 without reverting.
     */
    function principalBearingExposure(address token) external view override returns (uint256 exposure) {
        if (token != underlying) return 0;
        return IERC20(aToken).balanceOf(address(this)) + IERC20(underlying).balanceOf(address(this));
    }

    /**
     * @inheritdoc IYieldStrategy
     * @dev Reverts if `token != underlying` or `amount == 0`.
     *
     *      Execution flow:
     *        1. Pull `amount` from `vault` into this strategy (`safeTransferFrom`).
     *        2. Approve `aavePool` for exactly `amount`.
     *        3. Call `aavePool.supply(token, amount, address(this), 0)`. Aave mints aTokens
     *           to this contract. Referral code is hardcoded to 0.
     *        4. Require post-call underlying balance not to increase relative to pre-call balance,
     *           preventing silent partial-supply residue.
     *        5. Reset the pool's allowance to 0.
     *
     */
    function allocate(address token, uint256 amount) external override onlyVault nonReentrant {
        if (token != underlying || amount == 0) revert InvalidParam();

        uint256 beforeUnderlying = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(vault, address(this), amount);
        IERC20(token).forceApprove(address(aavePool), amount);
        aavePool.supply(token, amount, address(this), 0);
        uint256 afterUnderlying = IERC20(token).balanceOf(address(this));
        if (afterUnderlying > beforeUnderlying) {
            revert ResidualUnderlyingAfterSupply(beforeUnderlying, afterUnderlying);
        }
        IERC20(token).forceApprove(address(aavePool), 0);

        emit Allocated(token, amount);
    }

    /**
     * @inheritdoc IYieldStrategy
     * @dev Reverts if `token != underlying` or `amount == 0`.
     *
     *      Calls `aavePool.withdraw(token, amount, vault)`. Aave redeems aTokens held by
     *      this strategy and transfers the underlying directly to `vault`, bypassing this
     *      contract on the return path.
     *
     *      After Aave withdraw, any residual underlying held by this strategy (e.g. dust or
     *      direct donations) is swept to `vault`. This prevents permanent non-zero exposure
     *      due solely to strategy-held underlying balance.
     *
     */
    function deallocate(
        address token,
        uint256 amount
    ) external override onlyVault nonReentrant returns (uint256 received) {
        if (token != underlying || amount == 0) revert InvalidParam();
        return _deallocateAndSweep(amount);
    }

    /**
     * @inheritdoc IYieldStrategy
     * @dev Reverts if `token != underlying`.
     *
     *      Passes `type(uint256).max` to `aavePool.withdraw`, which Aave interprets as
     *      "withdraw the full aToken balance". The actual amount received may be slightly
     *      less than `aToken.balanceOf(this)` at the time of the call due to rounding in
     *      Aave's internal index math.
     *
     *      After Aave withdraw, any residual underlying held by this strategy is swept to
     *      `vault` and included in `received`.
     *
     */
    function deallocateAll(address token) external override onlyVault nonReentrant returns (uint256 received) {
        if (token != underlying) revert InvalidParam();
        return _deallocateAndSweep(type(uint256).max);
    }

    function _deallocateAndSweep(uint256 requested) internal returns (uint256 received) {
        received = aavePool.withdraw(underlying, requested, vault);
        uint256 swept = _sweepResidualUnderlyingToVault();
        if (swept != 0) received += swept;
        emit Deallocated(underlying, requested, received);
    }

    /// @dev Transfers any strategy-held underlying dust to vault and emits sweep telemetry.
    function _sweepResidualUnderlyingToVault() internal returns (uint256 swept) {
        swept = IERC20(underlying).balanceOf(address(this));
        if (swept == 0) return 0;
        IERC20(underlying).safeTransfer(vault, swept);
        emit ResidualUnderlyingSwept(underlying, swept);
    }
}
