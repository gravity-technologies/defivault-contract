// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";
import {IGRVTBaseTokenMintable} from "../external/IGRVTBaseTokenMintable.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";
import {IL1DefiVault} from "../interfaces/IL1DefiVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {
    TokenAmountComponent,
    StrategyAssetBreakdown,
    VaultTokenStatus,
    VaultTokenTotals
} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title GRVTDeFiVault
 * @notice Upgradeable L1 treasury vault for GRVT that manages three flows:
 *         (1) hold idle ERC20 liquidity,
 *         (2) allocate via whitelisted strategies and deallocate via withdrawable strategy entries, and
 *         (3) bridge idle liquidity to a fixed L2 exchange recipient via BridgeHub two-bridges requests.
 *
 * @dev ## Architecture overview
 *
 *      ### Role hierarchy
 *      DEFAULT_ADMIN_ROLE (deployer/multisig)
 *        └── VAULT_ADMIN_ROLE  – governs config, token support, strategy whitelist
 *              ├── REBALANCER_ROLE  – executes L1 → L2 bridge top-ups
 *              ├── ALLOCATOR_ROLE   – allocates/deallocates to yield strategies
 *              └── PAUSER_ROLE      – triggers pause/unpause
 *
 *      ### Three operational flows
 *      1. **Idle custody** – ERC20 tokens sit in the vault (via `token.balanceOf(address(this))`).
 *
 *      2. **Yield strategies** – ALLOCATOR pushes idle funds into whitelisted `IYieldStrategy`
 *         contracts (e.g. Aave V3). Balance accounting always uses on-chain balance deltas on
 *         the return path, not strategy-reported values, to defend against incorrect return data.
 *
 *      3. **L1 → L2 bridge** – REBALANCER calls `rebalanceToL2`, which bridges through
 *         BridgeHub's two-bridges path. The vault mints base token for `mintValue`.
 *         ERC20 bridge requests use `msg.value == 0`; native-intent requests unwrap
 *         wrapped native and forward native value to BridgeHub.
 *
 *      ### Pause semantics
 *      Pausing (via PAUSER_ROLE or VAULT_ADMIN_ROLE) blocks *risk-taking* actions:
 *        - `allocateToStrategy`
 *        - `rebalanceToL2`
 *      Defensive *exit* actions remain callable at all times, even when paused:
 *        - `deallocateFromStrategy` / `deallocateAllFromStrategy`
 *        - `emergencySendToL2`
 *
 *      ### Strategy lifecycle
 *      A strategy transitions through the following states for a given (token, strategy) pair:
 *        1. **Not registered** – `cfg.active == false`, config zeroed.
 *        2. **Whitelisted** – `cfg.whitelisted == true`, present in `_tokenStrategies`.
 *           Allocation is permitted up to `cfg.cap` (if non-zero).
 *        3. **Withdraw-only** – `cfg.whitelisted == false` but still present in `_tokenStrategies`
 *           because the strategy still holds funds. Allocation is blocked; deallocation is allowed.
 *        4. **Removed** – strategy is absent from `_tokenStrategies` and config is deleted.
 *           Reached when `IYieldStrategy.principalBearingExposure(token)` returns 0 at de-whitelist time, or
 *           after a full manual deallocation.
 *
 *      Transition from (2) to (3)/(4) is triggered by calling `whitelistStrategy` with
 *      `cfg.whitelisted == false`. The vault immediately enters withdraw-only mode and probes
 *      `strategy.principalBearingExposure(token)` to decide whether it can advance to (4) in the same call.
 *
 *      `active` exists to represent token-domain membership/lifecycle independently from allocation permission:
 *      - `whitelisted` answers "can we allocate new funds?"
 *      - `active` answers "should this strategy still be considered in withdraw/reporting/unwind paths?"
 *      This avoids per-call scans over `_tokenStrategies[token]` to infer membership and preserves O(1)
 *      membership checks for deallocation authorization.
 *
 *      ### Accounting fault tolerance
 *      `totalAssets` enforces strict exact-token accounting and reverts on invalid strategy reads.
 *      `totalAssetsStatus` / `totalAssetsBatch` skip invalid strategy reads and count
 *      `skippedStrategies` as a degraded-mode signal.
 *
 *      ### Emergency unwind
 *      `emergencySendToL2` bypasses normal rebalance policy and remains callable while paused.
 *      If idle funds are insufficient it
 *      iterates `_tokenStrategies` and pulls funds from each strategy via best-effort
 *      `try/catch` calls. Iteration is bounded by `MAX_STRATEGIES_PER_TOKEN`.
 *
 *      ### Upgrade safety
 *      50 reserved `__gap` slots follow all state variables to allow future layout additions
 *      without colliding with proxy storage.
 */
contract GRVTDeFiVault is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, IL1DefiVault {
    // ============================================= Constants ======================================================
    using SafeERC20 for IERC20;

    bytes32 public constant override VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant override REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant override ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant override PAUSER_ROLE = keccak256("PAUSER_ROLE");
    address internal constant NATIVE_TOKEN_SENTINEL = address(0);

    /// @notice Maximum number of strategies that can be simultaneously registered for a single token.
    /// @dev Bounds the gas cost of `emergencySendToL2` strategy iteration and prevents unbounded loops.
    uint256 public constant MAX_STRATEGIES_PER_TOKEN = 8;
    uint256 private constant L2_TX_GAS_LIMIT = 500_000;
    uint256 private constant L2_TX_GAS_PER_PUBDATA_BYTE = 800;

    // ============================================= Storage (Private) ==============================================

    /// @dev L1 BridgeHub contract used for outbound L1 → L2 transfers.
    address private _bridgeHub;

    /// @dev Mintable base token used for BridgeHub `mintValue` funding.
    address private _baseToken;

    /// @dev Target L2 chain id passed into BridgeHub requests.
    uint256 private _l2ChainId;

    /// @dev Canonical L2 exchange recipient for top-ups and emergency sends.
    address private _l2ExchangeRecipient;

    /// @dev Canonical wrapped-native ERC20 token used for internal accounting and strategy calls.
    address private _wrappedNativeToken;

    /// @dev Native dust/forced-send sweep destination.
    address private _treasury;

    /// @dev Global pause flag. When true, blocks `allocateToStrategy` and `rebalanceToL2`.
    bool private _paused;

    /// @dev Per-token support and risk-control parameters.
    mapping(address token => TokenConfig cfg) private _tokenConfigs;
    /// @dev Per-(token,strategy) tracked principal for yield/loss reconciliation.
    mapping(address token => mapping(address strategy => uint256 principal)) private _strategyPrincipal;

    // Strategy registry — two synchronized data structures:
    //
    // 1. `_strategyConfigs[token][strategy]`
    //    Source of truth for (token, strategy) lifecycle + authorization:
    //      - `whitelisted`: allocation permission
    //      - `active`: token-domain membership (including withdraw-only entries)
    //      - `cap`: optional allocation limit
    //    Consulted by allocation/deallocation authorization checks.
    //
    // 2. `_tokenStrategies[token]`
    //    Enumerable strategy list for a token; iterated by `totalAssets` and emergency unwinds.
    //    Contains both whitelisted and withdraw-only strategies (those with remaining positions).
    // Membership tests use `StrategyConfig.active` for O(1) checks; list insert/remove uses bounded linear scans
    // because `MAX_STRATEGIES_PER_TOKEN` caps list length.
    mapping(address token => mapping(address strategy => StrategyConfig cfg)) private _strategyConfigs;
    mapping(address token => address[] strategies) private _tokenStrategies;
    // Global active strategy index (deduped by strategy address) used by exact-token
    // reporting paths to support component/non-underlying token queries.
    address[] private _activeStrategies;
    mapping(address strategy => uint256 refs) private _activeStrategyRefCount;
    // Raw TVL root-token registry (source of truth) for on-chain discovery and batch reporting.
    // Read paths (`getTrackedTokens`, `isTrackedToken`, `totalAssetsBatch`) are intentionally
    // storage-backed and do not discover tokens by calling strategies at read time.
    address[] private _trackedRootTokens;
    mapping(address token => bool tracked) private _trackedRootTokenSet;

    /// @dev Reserved storage gap for upgrade-safe layout extension (50 × 32 bytes).
    uint256[50] private __gap;

    // =============================================== Events ===================================================
    /// @notice Emitted when the vault enters the paused state.
    event VaultPaused(address indexed account);

    /// @notice Emitted when the vault leaves the paused state.
    event VaultUnpaused(address indexed account);

    /// @notice Emitted when a token's `TokenConfig` is set or updated.
    event TokenConfigUpdated(address indexed token, TokenConfig cfg);

    /// @notice Emitted when root-token tracking status changes.
    event TokenTrackingUpdated(address indexed token, bool tracked);

    /**
     * @notice Emitted when a strategy's whitelist status for a token changes.
     * @param whitelisted  True when the strategy is being (re-)whitelisted; false when removed or de-listed.
     * @param cap          The allocation cap in effect after the update (0 = unlimited).
     */
    event StrategyWhitelistUpdated(address indexed token, address indexed strategy, bool whitelisted, uint256 cap);

    /**
     * @notice Emitted during `emergencySendToL2` when a strategy's funds cannot be retrieved.
     * @dev Skipping is non-fatal; the emergency flow continues with the next strategy.
     *      Causes include: `assets()` revert, `deallocate()` revert, or balance decreased after call.
     */
    event EmergencyStrategySkipped(address indexed token, address indexed strategy);

    /**
     * @notice Emitted during `whitelistStrategy` de-listing when exposure probe call reverts.
     * @dev The strategy remains in withdraw-only mode (still in `_tokenStrategies`) until its
     *      balance reaches zero and `whitelistStrategy` is called again to complete removal.
     */
    event StrategyRemovalCheckFailed(address indexed token, address indexed strategy);

    enum StrategyLifecycle {
        NotRegistered,
        Whitelisted,
        WithdrawOnly
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable vault.
     * @dev Can only be called once (enforced by `initializer`). Sets up the role hierarchy:
     *      DEFAULT_ADMIN_ROLE administers VAULT_ADMIN_ROLE; VAULT_ADMIN_ROLE administers the
     *      remaining operational roles. The `admin` address receives DEFAULT_ADMIN_ROLE,
     *      VAULT_ADMIN_ROLE, and PAUSER_ROLE — operational roles (REBALANCER, ALLOCATOR) must
     *      be granted separately.
     * @param admin                Initial governance admin account.
     * @param bridgeHub_           Initial BridgeHub address. Must be non-zero.
     * @param baseToken_           Initial mintable base token address. Must be non-zero.
     * @param l2ChainId_           Target L2 chain id. Must be non-zero.
     * @param l2ExchangeRecipient_ Initial L2 exchange recipient address. Must be non-zero.
     * @param wrappedNativeToken_  Canonical wrapped native token address. Must be non-zero.
     */
    function initialize(
        address admin,
        address bridgeHub_,
        address baseToken_,
        uint256 l2ChainId_,
        address l2ExchangeRecipient_,
        address wrappedNativeToken_
    ) external initializer {
        if (
            admin == address(0) ||
            bridgeHub_ == address(0) ||
            baseToken_ == address(0) ||
            l2ChainId_ == 0 ||
            l2ExchangeRecipient_ == address(0) ||
            wrappedNativeToken_ == address(0)
        ) {
            revert InvalidParam();
        }

        __AccessControl_init();
        __ReentrancyGuard_init();

        _setRoleAdmin(VAULT_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(REBALANCER_ROLE, VAULT_ADMIN_ROLE);
        _setRoleAdmin(ALLOCATOR_ROLE, VAULT_ADMIN_ROLE);
        _setRoleAdmin(PAUSER_ROLE, VAULT_ADMIN_ROLE);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        _bridgeHub = bridgeHub_;
        _baseToken = baseToken_;
        _l2ChainId = l2ChainId_;
        _l2ExchangeRecipient = l2ExchangeRecipient_;
        _wrappedNativeToken = wrappedNativeToken_;
        _treasury = admin;
    }

    // ============================================= Modifiers ======================================================

    /// @dev Reverts if caller lacks VAULT_ADMIN_ROLE.
    modifier onlyVaultAdmin() {
        if (!hasRole(VAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    /// @dev Reverts if caller lacks both PAUSER_ROLE and VAULT_ADMIN_ROLE.
    modifier onlyPauserOrAdmin() {
        if (!(hasRole(PAUSER_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
        _;
    }

    /// @dev Reverts if caller lacks ALLOCATOR_ROLE.
    modifier onlyAllocator() {
        if (!hasRole(ALLOCATOR_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    /// @dev Reverts if the vault is currently paused.
    modifier whenNotPaused() {
        if (_paused) revert Paused();
        _;
    }

    /// @dev Reverts if caller lacks both ALLOCATOR_ROLE and VAULT_ADMIN_ROLE.
    modifier onlyAllocatorOrAdmin() {
        if (!(hasRole(ALLOCATOR_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
        _;
    }

    /// @dev Reverts if caller lacks both REBALANCER_ROLE and VAULT_ADMIN_ROLE.
    modifier onlyRebalancerOrAdmin() {
        if (!(hasRole(REBALANCER_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
        _;
    }

    /// @dev Reverts if caller lacks REBALANCER_ROLE.
    modifier onlyRebalancer() {
        if (!hasRole(REBALANCER_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    /// @inheritdoc IL1DefiVault
    function hasRole(
        bytes32 role,
        address account
    ) public view override(AccessControlUpgradeable, IL1DefiVault) returns (bool) {
        return super.hasRole(role, account);
    }

    /// @inheritdoc IL1DefiVault
    function bridgeHub() external view override returns (address) {
        return _bridgeHub;
    }

    /// @inheritdoc IL1DefiVault
    function baseToken() external view override returns (address) {
        return _baseToken;
    }

    /// @inheritdoc IL1DefiVault
    function l2ChainId() external view override returns (uint256) {
        return _l2ChainId;
    }

    /// @inheritdoc IL1DefiVault
    function l2ExchangeRecipient() external view override returns (address) {
        return _l2ExchangeRecipient;
    }

    /// @inheritdoc IL1DefiVault
    function wrappedNativeToken() external view override returns (address) {
        return _wrappedNativeToken;
    }

    /// @inheritdoc IL1DefiVault
    function paused() external view override returns (bool) {
        return _paused;
    }

    /// @dev Accept native ETH only from the canonical wrapped-native token contract.
    receive() external payable {
        if (msg.sender != _wrappedNativeToken) revert InvalidParam();
    }

    /// @dev Reject unexpected calldata-bearing native sends.
    fallback() external payable {
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function sweepNative(uint256 amount) external override onlyVaultAdmin nonReentrant {
        if (amount == 0 || _treasury == address(0) || amount > address(this).balance) revert InvalidParam();
        (bool ok, ) = _treasury.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeSwept(_treasury, amount);
    }

    /// @inheritdoc IL1DefiVault
    function pause() external override onlyPauserOrAdmin {
        if (_paused) revert InvalidParam();
        _paused = true;
        emit VaultPaused(msg.sender);
    }

    /// @inheritdoc IL1DefiVault
    function unpause() external override onlyPauserOrAdmin {
        if (!_paused) revert InvalidParam();
        _paused = false;
        emit VaultUnpaused(msg.sender);
    }

    /// @inheritdoc IL1DefiVault
    function getTokenConfig(address token) external view override returns (TokenConfig memory) {
        return _tokenConfigs[_canonicalToken(token)];
    }

    /// @inheritdoc IL1DefiVault
    function setTokenConfig(address token, TokenConfig calldata cfg) external override onlyVaultAdmin {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0)) revert InvalidParam();
        if (!_supportsBalanceOf(canonicalToken)) revert InvalidParam();
        _tokenConfigs[canonicalToken] = cfg;
        emit TokenConfigUpdated(canonicalToken, cfg);
        _afterTokenBalanceChange(canonicalToken);
    }

    /// @inheritdoc IL1DefiVault
    function isStrategyWhitelisted(address token, address strategy) external view override returns (bool) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0) || strategy == address(0)) revert InvalidParam();
        return _strategyConfigs[canonicalToken][strategy].whitelisted;
    }

    /// @inheritdoc IL1DefiVault
    function getStrategyConfig(address token, address strategy) external view override returns (StrategyConfig memory) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0) || strategy == address(0)) revert InvalidParam();
        return _strategyConfigs[canonicalToken][strategy];
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev All strategy lifecycle transitions are centralized via `_setStrategyLifecycle`.
     */
    function whitelistStrategy(
        address token,
        address strategy,
        StrategyConfig calldata cfg
    ) external override onlyVaultAdmin {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0) || strategy == address(0)) revert InvalidParam();
        if (cfg.whitelisted && !_tokenConfigs[canonicalToken].supported) revert TokenNotSupported();

        if (cfg.whitelisted) {
            _setStrategyLifecycle(canonicalToken, strategy, StrategyLifecycle.Whitelisted, cfg.cap);
            return;
        }

        if (!_isActiveStrategy(canonicalToken, strategy)) {
            _setStrategyLifecycle(canonicalToken, strategy, StrategyLifecycle.NotRegistered, 0);
            return;
        }

        bool canRemove;
        try IYieldStrategy(strategy).principalBearingExposure(canonicalToken) returns (uint256 exposure) {
            canRemove = exposure == 0;
        } catch {
            emit StrategyRemovalCheckFailed(canonicalToken, strategy);
        }
        _setStrategyLifecycle(
            canonicalToken,
            strategy,
            canRemove ? StrategyLifecycle.NotRegistered : StrategyLifecycle.WithdrawOnly,
            canRemove ? 0 : cfg.cap
        );
    }

    /// @inheritdoc IL1DefiVault
    function idleAssets(address token) public view override returns (uint256) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0)) return 0;
        (bool ok, uint256 balance) = _tryBalanceOf(canonicalToken, address(this));
        if (!ok) return 0;
        return balance;
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Returns an empty component list if the strategy is not globally active.
     *      Strategy call failures are normalized to `InvalidStrategyAssetsRead`.
     */
    function strategyAssets(
        address token,
        address strategy
    ) public view override returns (StrategyAssetBreakdown memory breakdown) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0) || strategy == address(0)) revert InvalidParam();
        if (!_isGloballyActiveStrategy(strategy)) return breakdown;
        try IYieldStrategy(strategy).assets(canonicalToken) returns (StrategyAssetBreakdown memory data) {
            return data;
        } catch {
            revert InvalidStrategyAssetsRead(canonicalToken, strategy);
        }
    }

    /// @inheritdoc IL1DefiVault
    function totalAssets(address token) public view override returns (VaultTokenTotals memory totals) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0)) revert InvalidParam();

        totals.idle = idleAssets(canonicalToken);
        totals.total = totals.idle;

        address[] storage list = _activeStrategies;
        for (uint256 i = 0; i < list.length; ++i) {
            (bool ok, uint256 amount) = _readStrategyExactComponent(canonicalToken, list[i]);
            if (!ok) revert InvalidStrategyAssetsRead(canonicalToken, list[i]);
            if (amount > type(uint256).max - totals.strategy) {
                revert InvalidStrategyAssetsRead(canonicalToken, list[i]);
            }
            if (amount > type(uint256).max - totals.total) revert InvalidStrategyAssetsRead(canonicalToken, list[i]);
            totals.strategy += amount;
            totals.total += amount;
        }
    }

    /// @inheritdoc IL1DefiVault
    function totalAssetsStatus(address token) external view override returns (VaultTokenStatus memory status) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0)) revert InvalidParam();
        return _buildTokenStatus(canonicalToken);
    }

    /// @inheritdoc IL1DefiVault
    function getTrackedTokens() external view override returns (address[] memory) {
        return _trackedRootTokens;
    }

    /// @inheritdoc IL1DefiVault
    function isTrackedToken(address token) external view override returns (bool) {
        if (token == address(0)) revert InvalidParam();
        return _trackedRootTokenSet[token];
    }

    /// @inheritdoc IL1DefiVault
    function totalAssetsBatch(
        address[] calldata tokens
    ) external view override returns (VaultTokenStatus[] memory statuses) {
        statuses = new VaultTokenStatus[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            address canonicalToken = _canonicalToken(tokens[i]);
            if (canonicalToken == address(0)) revert InvalidParam();
            statuses[i] = _buildTokenStatus(canonicalToken);
        }
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Returns 0 if the token is not supported. Otherwise returns full idle assets.
     */
    function availableForRebalance(address token) public view override returns (uint256) {
        address canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0)) return 0;

        TokenConfig memory cfg = _tokenConfigs[canonicalToken];
        if (!cfg.supported) return 0;

        (bool ok, uint256 balance) = _tryBalanceOf(canonicalToken, address(this));
        if (!ok) return 0;
        return balance;
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Enforces in order:
     *      1. Token is supported (`TokenConfig.supported == true`).
     *      2. Strategy is whitelisted (`StrategyConfig.whitelisted == true`).
     *      3. If `StrategyConfig.cap != 0`, the strategy's existing principal-bearing exposure
     *         plus `amount` must not exceed the cap. The cap check reads
     *         `strategy.principalBearingExposure(token)`.
     *
     *      Approval pattern: the vault grants an exact `amount` allowance to `strategy`,
     *      calls `strategy.allocate`, then resets the allowance to 0. This minimises residual
     *      approval exposure in case the strategy does not consume the full allowance.
     *
     *      This function is blocked when the vault is paused.
     */
    function allocateToStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external override nonReentrant whenNotPaused onlyAllocator {
        address canonicalToken = _requireBoundaryToken(token);
        if (strategy == address(0) || amount == 0) revert InvalidParam();

        TokenConfig memory cfg = _tokenConfigs[canonicalToken];
        if (!cfg.supported) revert TokenNotSupported();
        StrategyConfig memory sCfg = _strategyConfigs[canonicalToken][strategy];
        if (!sCfg.whitelisted) revert StrategyNotWhitelisted();

        uint256 idle = idleAssets(canonicalToken);
        if (idle < amount) revert InvalidParam();

        if (sCfg.cap != 0) {
            uint256 current;
            try IYieldStrategy(strategy).principalBearingExposure(canonicalToken) returns (uint256 exposure) {
                current = exposure;
            } catch {
                revert InvalidStrategyExposureRead(canonicalToken, strategy);
            }
            if (current > type(uint256).max - amount || current + amount > sCfg.cap) revert CapExceeded();
        }

        IERC20(canonicalToken).forceApprove(strategy, amount);
        IYieldStrategy(strategy).allocate(canonicalToken, amount);
        IERC20(canonicalToken).forceApprove(strategy, 0);

        uint256 principal = _strategyPrincipal[canonicalToken][strategy];
        if (amount > type(uint256).max - principal) revert InvalidParam();
        _strategyPrincipal[canonicalToken][strategy] = principal + amount;
        emit Allocate(canonicalToken, strategy, amount);
        _afterTokenBalanceChange(canonicalToken);
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Callable while paused and when token support is removed (defensive exit).
     *
     *      Authorization: requires the strategy to be either whitelisted OR still present in
     *      `_tokenStrategies` (withdraw-only mode). This allows recovery from strategies that
     *      were de-listed while still holding funds.
     *
     *      Accounting: uses an on-chain balance delta (`afterBal - beforeBal`) as the
     *      authoritative `received` value. If the strategy's self-reported return value differs,
     *      a `StrategyReportedReceivedMismatch` event is emitted but the call does not revert —
     *      the measured delta is always used for downstream accounting.
     *
     *      Reverts if the vault's token balance decreases after the strategy call (should be
     *      impossible for a correct strategy, but guards against malicious strategy implementations).
     */
    function deallocateFromStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external override nonReentrant onlyAllocatorOrAdmin returns (uint256 received) {
        address canonicalToken = _requireBoundaryToken(token);
        if (strategy == address(0) || amount == 0) revert InvalidParam();
        if (!_canWithdrawFromStrategy(canonicalToken, strategy)) revert StrategyNotWhitelisted();
        received = _deallocateWithBalanceDelta(canonicalToken, strategy, amount, false);
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Callable while paused and when token support is removed (defensive exit).
     *
     *      Equivalent to `deallocateFromStrategy` but calls `strategy.deallocateAll` instead of
     *      `strategy.deallocate`. Uses `type(uint256).max` as the `requested` field in events to
     *      signal an uncapped unwind.
     *
     *      Accounting: same balance-delta approach as `deallocateFromStrategy`. Mismatch between
     *      strategy-reported and measured received amount triggers `StrategyReportedReceivedMismatch`.
     */
    function deallocateAllFromStrategy(
        address token,
        address strategy
    ) external override nonReentrant onlyAllocatorOrAdmin returns (uint256 received) {
        address canonicalToken = _requireBoundaryToken(token);
        if (strategy == address(0)) revert InvalidParam();
        if (!_canWithdrawFromStrategy(canonicalToken, strategy)) revert StrategyNotWhitelisted();
        received = _deallocateWithBalanceDelta(canonicalToken, strategy, type(uint256).max, true);
    }

    /**
     * @notice Shared deallocation accounting for normal and deallocate-all paths.
     * @param token The underlying token being withdrawn.
     * @param strategy The strategy to withdraw from.
     * @param requested Requested amount for events (`type(uint256).max` for deallocate-all).
     * @param useAll True to call `deallocateAll`, false to call `deallocate(requested)`.
     */
    function _deallocateWithBalanceDelta(
        address token,
        address strategy,
        uint256 requested,
        bool useAll
    ) internal returns (uint256 received) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        uint256 reported = useAll
            ? IYieldStrategy(strategy).deallocateAll(token)
            : IYieldStrategy(strategy).deallocate(token, requested);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert InvalidParam();
        received = afterBal - beforeBal;

        if (reported != received) {
            emit StrategyReportedReceivedMismatch(token, strategy, requested, reported, received);
        }
        emit Deallocate(token, strategy, requested, received);
        _applyPrincipalWriteDown(token, strategy);
        _afterTokenBalanceChange(token);
    }

    /// @inheritdoc IL1DefiVault
    function rebalanceToL2(address, uint256) external payable override nonReentrant whenNotPaused onlyRebalancer {
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function emergencySendToL2(address, uint256) external payable override nonReentrant onlyRebalancerOrAdmin {
        revert InvalidParam();
    }

    /**
     * @notice Returns the current active strategy list for a token.
     * @dev Includes withdraw-only strategies that still hold a position (pending full removal).
     *      The array length is bounded by `MAX_STRATEGIES_PER_TOKEN`.
     * @param token The ERC20 token address.
     * @return Array of strategy addresses currently tracked for `token`.
     */
    function getTokenStrategies(address token) external view override returns (address[] memory) {
        return _tokenStrategies[_canonicalToken(token)];
    }

    /**
     * @notice Builds degraded totals for a canonical token key.
     * @dev Scans global active strategies so non-underlying component-token queries are complete.
     * Invalid strategy reads or malformed component payloads are skipped and counted.
     */
    function _buildTokenStatus(address canonicalToken) internal view returns (VaultTokenStatus memory status) {
        status.idle = idleAssets(canonicalToken);
        status.total = status.idle;

        address[] storage list = _activeStrategies;
        for (uint256 i = 0; i < list.length; ++i) {
            (bool ok, uint256 amount) = _readStrategyExactComponent(canonicalToken, list[i]);
            if (!ok || amount > type(uint256).max - status.strategy || amount > type(uint256).max - status.total) {
                unchecked {
                    ++status.skippedStrategies;
                }
                continue;
            }
            status.strategy += amount;
            status.total += amount;
        }
    }

    /**
     * @notice Reads exact-token component sum from a strategy report.
     * @dev A malformed payload (zero component token or overflow) returns `(false, 0)`.
     */
    function _readStrategyExactComponent(
        address token,
        address strategy
    ) internal view returns (bool ok, uint256 amount) {
        StrategyAssetBreakdown memory breakdown;
        try IYieldStrategy(strategy).assets(token) returns (StrategyAssetBreakdown memory data) {
            breakdown = data;
        } catch {
            return (false, 0);
        }

        TokenAmountComponent[] memory components = breakdown.components;
        for (uint256 i = 0; i < components.length; ++i) {
            if (components[i].token == address(0)) return (false, 0);
            if (components[i].token != token) continue;
            if (components[i].amount > type(uint256).max - amount) return (false, 0);
            amount += components[i].amount;
        }
        return (true, amount);
    }

    /**
     * @notice Returns whether a token should be retained as a root tracked token.
     * @dev Conservative on strategy read failures to avoid under-reporting.
     */
    function _shouldTrackRootToken(address token) internal view returns (bool) {
        if (_tokenConfigs[token].supported) return true;
        return _hasAnyExposure(token);
    }

    function _afterTokenBalanceChange(address token) internal {
        _reconcileTrackedToken(token);
    }

    function _hasAnyExposure(address token) internal view returns (bool) {
        if (idleAssets(token) != 0) return true;

        address[] storage list = _activeStrategies;
        for (uint256 i = 0; i < list.length; ++i) {
            (bool ok, uint256 exactAmount) = _readStrategyExactComponent(token, list[i]);
            if (!ok) return true;
            if (exactAmount != 0) return true;
            try IYieldStrategy(list[i]).principalBearingExposure(token) returns (uint256 exposure) {
                if (exposure != 0) return true;
            } catch {
                return true;
            }
        }
        return false;
    }

    function _addTrackedRootToken(address token) internal {
        if (_trackedRootTokenSet[token]) return;
        _trackedRootTokens.push(token);
        _trackedRootTokenSet[token] = true;
    }

    function _removeTrackedRootToken(address token) internal {
        if (!_trackedRootTokenSet[token]) return;
        uint256 removeIndex = type(uint256).max;
        for (uint256 i = 0; i < _trackedRootTokens.length; ++i) {
            if (_trackedRootTokens[i] == token) {
                removeIndex = i;
                break;
            }
        }
        if (removeIndex == type(uint256).max) return;

        uint256 lastIndex = _trackedRootTokens.length - 1;
        if (removeIndex != lastIndex) {
            _trackedRootTokens[removeIndex] = _trackedRootTokens[lastIndex];
        }
        _trackedRootTokens.pop();
        delete _trackedRootTokenSet[token];
    }

    function _reconcileTrackedToken(address token) internal {
        bool shouldTrack = _shouldTrackRootToken(token);
        bool currentlyTracked = _trackedRootTokenSet[token];
        if (shouldTrack && !currentlyTracked) {
            _addTrackedRootToken(token);
            emit TokenTrackingUpdated(token, true);
            return;
        }
        if (!shouldTrack && currentlyTracked) {
            _removeTrackedRootToken(token);
            emit TokenTrackingUpdated(token, false);
        }
    }

    function _setStrategyLifecycle(address token, address strategy, StrategyLifecycle lifecycle, uint256 cap) internal {
        if (lifecycle == StrategyLifecycle.NotRegistered) {
            if (_isActiveStrategy(token, strategy)) _removeStrategy(token, strategy);
            delete _strategyConfigs[token][strategy];
            delete _strategyPrincipal[token][strategy];
            emit StrategyWhitelistUpdated(token, strategy, false, 0);
            _afterTokenBalanceChange(token);
            return;
        }

        if (!_isActiveStrategy(token, strategy)) _addStrategy(token, strategy);
        StrategyConfig storage current = _strategyConfigs[token][strategy];
        current.whitelisted = lifecycle == StrategyLifecycle.Whitelisted;
        current.active = true;
        current.cap = cap;
        emit StrategyWhitelistUpdated(token, strategy, current.whitelisted, cap);
        _afterTokenBalanceChange(token);
    }

    /**
     * @notice Converts boundary token intent into canonical token key.
     * @param token Boundary token key (`address(0)` denotes native ETH intent).
     * @return canonicalToken Canonical ERC20 token key.
     */
    function _canonicalToken(address token) internal view returns (address canonicalToken) {
        if (token == NATIVE_TOKEN_SENTINEL) {
            return _wrappedNativeToken;
        }
        return token;
    }

    /**
     * @notice Validates boundary token input for mutating APIs.
     * @dev Passing wrapped native directly is rejected; use native sentinel (`address(0)`) for native intent.
     */
    function _requireBoundaryToken(address token) internal view returns (address canonicalToken) {
        if (token == _wrappedNativeToken) revert InvalidParam();
        canonicalToken = _canonicalToken(token);
        if (canonicalToken == address(0)) revert InvalidParam();
    }

    /**
     * @notice Probes whether a token supports readable ERC20 `balanceOf`.
     */
    function _supportsBalanceOf(address token) internal view returns (bool supported) {
        (supported, ) = _tryBalanceOf(token, address(this));
    }

    /**
     * @notice Performs a defensive `balanceOf` staticcall.
     * @return ok True when call succeeds and returns at least one word.
     * @return balance Decoded balance when `ok` is true; otherwise `0`.
     */
    function _tryBalanceOf(address token, address account) internal view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (!success || data.length < 32) {
            return (false, 0);
        }
        return (true, abi.decode(data, (uint256)));
    }

    /**
     * @notice Clamps stored principal to current strategy exposure after unwind.
     * @dev Emits telemetry and never reverts unwind path on exposure read failure.
     */
    function _applyPrincipalWriteDown(address token, address strategy) internal {
        uint256 previousPrincipal = _strategyPrincipal[token][strategy];
        if (previousPrincipal == 0) return;

        uint256 exposureAfter;
        try IYieldStrategy(strategy).principalBearingExposure(token) returns (uint256 exposure) {
            exposureAfter = exposure;
        } catch {
            emit StrategyPrincipalWriteDownSkipped(token, strategy);
            return;
        }

        if (previousPrincipal <= exposureAfter) return;
        _strategyPrincipal[token][strategy] = exposureAfter;
        emit StrategyPrincipalWrittenDown(token, strategy, previousPrincipal, exposureAfter, exposureAfter);
    }

    /**
     * @notice Returns true if `strategy` is present in the active strategy list for `token`.
     * @dev Membership is tracked directly in `StrategyConfig.active` for O(1) checks.
     *      This avoids scanning `_tokenStrategies[token]` at each authorization/read call site.
     */
    function _isActiveStrategy(address token, address strategy) internal view returns (bool) {
        return _strategyConfigs[token][strategy].active;
    }

    /**
     * @notice Returns true when a strategy is active under at least one token domain.
     */
    function _isGloballyActiveStrategy(address strategy) internal view returns (bool) {
        return _activeStrategyRefCount[strategy] != 0;
    }

    /**
     * @notice Returns true if funds may be withdrawn from `strategy` for `token`.
     * @dev Withdrawal is permitted when the strategy is either:
     *      - Whitelisted (`StrategyConfig.whitelisted == true`), OR
     *      - Active (present in `_tokenStrategies`) — i.e. in withdraw-only mode.
     *
     *      This keeps the deallocation path resilient during de-whitelist transitions: allocation
     *      permission can be revoked immediately (`whitelisted = false`) while existing positions
     *      remain withdrawable until fully drained (`active = true` until removal).
     */
    function _canWithdrawFromStrategy(address token, address strategy) internal view returns (bool) {
        return _strategyConfigs[token][strategy].whitelisted || _isActiveStrategy(token, strategy);
    }

    /**
     * @notice Appends `strategy` to the active strategy list for `token`.
     * @dev Reverts with `CapExceeded` if `_tokenStrategies[token].length == MAX_STRATEGIES_PER_TOKEN`.
     *      Caller must ensure `strategy` is not already active for `token`.
     */
    function _addStrategy(address token, address strategy) internal {
        if (_isActiveStrategy(token, strategy)) revert InvalidParam();
        address[] storage list = _tokenStrategies[token];
        if (list.length >= MAX_STRATEGIES_PER_TOKEN) revert CapExceeded();
        list.push(strategy);
        _strategyConfigs[token][strategy].active = true;
        _increaseGlobalActiveStrategy(strategy);
    }

    /**
     * @notice Removes `strategy` from the active strategy list for `token` using swap-pop.
     * @dev No-op if `strategy` is not present.
     *
     *      Since list length is bounded by `MAX_STRATEGIES_PER_TOKEN`, a linear scan is used
     *      to find the index, followed by standard swap-pop removal.
     *
     *      Order of elements in `_tokenStrategies` is not preserved, which is acceptable
     *      because all consumers treat it as an unordered set.
     */
    function _removeStrategy(address token, address strategy) internal {
        address[] storage list = _tokenStrategies[token];
        uint256 removeIndex = type(uint256).max;
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == strategy) {
                removeIndex = i;
                break;
            }
        }
        if (removeIndex == type(uint256).max) return;

        uint256 lastIndex = list.length - 1;
        if (removeIndex != lastIndex) {
            list[removeIndex] = list[lastIndex];
        }
        list.pop();
        _strategyConfigs[token][strategy].active = false;
        _decreaseGlobalActiveStrategy(strategy);
    }

    /**
     * @notice Increments global active-reference count for `strategy`.
     * @dev Adds strategy to `_activeStrategies` on first active token binding.
     */
    function _increaseGlobalActiveStrategy(address strategy) internal {
        uint256 refs = _activeStrategyRefCount[strategy];
        if (refs == 0) {
            _activeStrategies.push(strategy);
        }
        _activeStrategyRefCount[strategy] = refs + 1;
    }

    /**
     * @notice Decrements global active-reference count for `strategy`.
     * @dev Removes strategy from `_activeStrategies` when no active token bindings remain.
     */
    function _decreaseGlobalActiveStrategy(address strategy) internal {
        uint256 refs = _activeStrategyRefCount[strategy];
        if (refs == 0) return;
        if (refs > 1) {
            _activeStrategyRefCount[strategy] = refs - 1;
            return;
        }

        delete _activeStrategyRefCount[strategy];
        uint256 removeIndex = type(uint256).max;
        for (uint256 i = 0; i < _activeStrategies.length; ++i) {
            if (_activeStrategies[i] == strategy) {
                removeIndex = i;
                break;
            }
        }
        if (removeIndex == type(uint256).max) return;

        uint256 lastIndex = _activeStrategies.length - 1;
        if (removeIndex != lastIndex) {
            _activeStrategies[removeIndex] = _activeStrategies[lastIndex];
        }
        _activeStrategies.pop();
    }
}
