// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IL1ZkSyncBridgeHub} from "../external/IL1ZkSyncBridgeHub.sol";
import {IGRVTBaseTokenMintable} from "../external/IGRVTBaseTokenMintable.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {INativeBridgeGateway} from "../interfaces/INativeBridgeGateway.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {PositionComponent, ConservativeTokenTotals, TokenTotals} from "../interfaces/IVaultReportingTypes.sol";
import {VaultBridgeLib} from "./VaultBridgeLib.sol";
import {VaultStrategyOpsLib} from "./VaultStrategyOpsLib.sol";

/**
 * @title GRVTL1TreasuryVault
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
 *         contracts (e.g. Aave V3). Cost basis on allocate uses vault-side net balance decrease;
 *         unwind accounting uses vault-side balance deltas rather than trusting strategy-reported values.
 *
 *      3. **L1 → L2 bridge** – REBALANCER calls split native/ERC20 rebalance paths.
 *         ERC20 bridge requests are submitted directly through BridgeHub's two-bridges path.
 *         Native-intent requests route through `NativeBridgeGateway`, which becomes the zkSync
 *         deposit sender so failed native deposits can be reclaimed without sending ETH back to the vault.
 *
 *      ### Pause semantics
 *      Pausing (via PAUSER_ROLE or VAULT_ADMIN_ROLE) blocks *risk-taking* actions:
 *        - `allocateVaultTokenToStrategy`
 *        - `rebalanceNativeToL2`
 *        - `rebalanceErc20ToL2`
 *        - `harvestYieldFromStrategy`
 *      Defensive *exit* actions remain callable at all times, even when paused:
 *        - `deallocateVaultTokenFromStrategy` / `deallocateAllVaultTokenFromStrategy`
 *        - `emergencyNativeToL2`
 *        - `emergencyErc20ToL2`
 *
 *      ### Strategy lifecycle
 *      A strategy transitions through the following states for a given (token, strategy) pair:
 *        1. **Not registered** – `cfg.active == false`, config zeroed.
 *        2. **Whitelisted** – `cfg.whitelisted == true`, present in `_vaultTokenStrategies`.
 *           Allocation is permitted up to `cfg.cap` (if non-zero).
 *        3. **Withdraw-only** – `cfg.whitelisted == false` but still present in `_vaultTokenStrategies`
 *           because the strategy still holds funds. Allocation is blocked; deallocation is allowed.
 *        4. **Removed** – strategy is absent from `_vaultTokenStrategies` and config is deleted.
 *           Reached when `IYieldStrategy.strategyExposure(token)` returns 0 at de-whitelist time, or
 *           after a full manual deallocation.
 *
 *      Transition from (2) to (3)/(4) is triggered by calling `setVaultTokenStrategyConfig` with
 *      `cfg.whitelisted == false`. The vault immediately enters withdraw-only mode and probes
 *      `strategy.strategyExposure(token)` to decide whether it can advance to (4) in the same call.
 *
 *      `active` exists to represent vault-token membership/lifecycle independently from allocation permission:
 *      - `whitelisted` answers "can we allocate new funds?"
 *      - `active` answers "should this strategy still be considered in withdraw/reporting/unwind paths?"
 *      This avoids per-call scans over `_vaultTokenStrategies[token]` to infer membership and preserves O(1)
 *      membership checks for deallocation authorization.
 *
 *      ### Accounting fault tolerance
 *      `tokenTotals` enforces strict exact-token accounting and reverts on invalid strategy reads.
 *      `tokenTotalsConservative` / `tokenTotalsBatch` skip invalid strategy reads and count
 *      `skippedStrategies` as a best-effort-read signal.
 *
 *      ### Emergency unwind
 *      `emergencyNativeToL2` and `emergencyErc20ToL2` bypass normal rebalance policy and remain callable while paused.
 *      If idle funds are insufficient it
 *      iterates `_vaultTokenStrategies` and pulls funds from each strategy via best-effort
 *      `try/catch` calls. Iteration is bounded by `MAX_STRATEGIES_PER_TOKEN`.
 *
 *      ### Upgrade safety
 *      50 reserved `__gap` slots follow all state variables to allow future layout additions
 *      without colliding with proxy storage.
 */
contract GRVTL1TreasuryVault is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, IL1TreasuryVault {
    // ============================================= Constants ======================================================
    using SafeERC20 for IERC20;

    bytes32 public constant override VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant override REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant override ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant override PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Maximum number of strategies that can be simultaneously registered for a single token.
    /// @dev Bounds the gas cost of emergency strategy iteration and prevents unbounded loops.
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

    /// @dev Configured L2 exchange recipient for top-ups and emergency sends.
    address private _l2ExchangeRecipient;

    /// @dev Wrapped-native ERC20 token used for internal accounting and strategy calls.
    address private _wrappedNativeToken;

    /// @dev Native bridge gateway used for L1 -> L2 native sends and failed-deposit recovery.
    address private _nativeBridgeGateway;

    /// @dev Native dust/forced-send sweep yield recipient.
    address private _yieldRecipient;

    /// @dev Global pause flag. When true, blocks `allocateVaultTokenToStrategy` and normal rebalances.
    bool private _paused;

    /// @dev Per-token support and risk-control parameters.
    mapping(address token => VaultTokenConfig cfg) private _vaultTokenConfigs;
    /// @dev Per-(token,strategy) tracked cost basis used for yield/loss reconciliation.
    mapping(address token => mapping(address strategy => uint256 costBasis)) private _strategyCostBasis;

    // Strategy registry — two synchronized data structures:
    //
    // 1. `_vaultTokenStrategyConfigs[token][strategy]`
    //    Source of truth for (token, strategy) lifecycle + authorization:
    //      - `whitelisted`: allocation permission
    //      - `active`: vault-token membership (including withdraw-only entries)
    //      - `cap`: optional allocation limit
    //    Consulted by allocation/deallocation authorization checks.
    //
    // 2. `_vaultTokenStrategies[token]`
    //    Enumerable strategy list for a token; iterated by `tokenTotals` and emergency unwinds.
    //    Contains both whitelisted and withdraw-only strategies (those with remaining positions).
    // Membership tests use `VaultTokenStrategyConfig.active` for O(1) checks; list insert/remove uses bounded linear scans
    // because `MAX_STRATEGIES_PER_TOKEN` caps list length.
    mapping(address token => mapping(address strategy => VaultTokenStrategyConfig cfg))
        private _vaultTokenStrategyConfigs;
    mapping(address token => address[] strategies) private _vaultTokenStrategies;
    // Global active strategy index (deduped by strategy address) used by exact-token
    // reporting paths to support component/non-underlying token queries.
    address[] private _activeStrategies;
    mapping(address strategy => uint256 refs) private _activeStrategyRefCount;
    // Supported vault-token registry used for normal operations discovery.
    address[] private _supportedVaultTokens;
    mapping(address token => bool supported) private _supportedVaultTokenSet;
    // Raw TVL-token registry (source of truth) for on-chain discovery and batch reporting.
    // Read paths (`getTrackedTvlTokens`, `isTrackedTvlToken`, `tokenTotalsBatch`, `trackedTvlTokenTotals`) are intentionally
    // storage-backed and do not discover tokens by calling strategies at read time.
    address[] private _trackedTvlTokens;
    mapping(address token => bool tracked) private _trackedTvlTokenSet;
    mapping(address token => uint256 refs) private _trackedTvlTokenRefCount;
    mapping(address token => bool trackedDirectly) private _vaultTokenDirectTvlTracked;
    mapping(address vaultToken => mapping(address strategy => address[] tokens)) private _cachedStrategyTvlTokens;
    // Optional admin override for tracked-TVL-token signal (emergency use only).
    mapping(address token => bool enabled) private _trackedTvlTokenOverrideEnabled;
    mapping(address token => bool forceTrack) private _trackedTvlTokenOverrideValue;
    /// @dev Timelock controller authorized to update yield recipient.
    address private _yieldRecipientTimelockController;

    /// @dev Reserved storage gap for upgrade-safe layout extension (50 × 32 bytes).
    uint256[50] private __gap;

    // =============================================== Events ===================================================
    /// @notice Emitted when the vault enters the paused state.
    event VaultPaused(address indexed account);

    /// @notice Emitted when the vault leaves the paused state.
    event VaultUnpaused(address indexed account);

    /// @notice Emitted when a token's `VaultTokenConfig` is set or updated.
    event VaultTokenConfigUpdated(address indexed token, VaultTokenConfig cfg);

    /**
     * @notice Emitted when a strategy's whitelist status for a token changes.
     * @param whitelisted  True when the strategy is being (re-)whitelisted; false when removed or de-listed.
     * @param cap          The allocation cap in effect after the update (0 = unlimited).
     */
    event VaultTokenStrategyConfigUpdated(
        address indexed vaultToken,
        address indexed strategy,
        bool whitelisted,
        uint256 cap
    );

    /**
     * @notice Emitted during emergency unwind when a strategy's funds cannot be retrieved.
     * @dev Skipping is non-fatal; the emergency flow continues with the next strategy.
     *      Causes include: reporting read revert, `deallocate()` revert, or balance decreased after call.
     */
    event EmergencyStrategySkipped(address indexed vaultToken, address indexed strategy);

    /**
     * @notice Emitted during `setVaultTokenStrategyConfig` de-listing when exposure probe call reverts.
     * @dev The strategy remains in withdraw-only mode (still in `_vaultTokenStrategies`) until its
     *      balance reaches zero and `setVaultTokenStrategyConfig` is called again to complete removal.
     */
    event StrategyRemovalCheckFailed(address indexed vaultToken, address indexed strategy);

    /**
     * @notice Internal lifecycle state for one `(vaultToken, strategy)` pair.
     */
    enum StrategyLifecycle {
        /// @notice Binding is absent from the active set and cannot be used.
        /// @dev Strategy is fully removed for this vault token.
        NotRegistered,
        /// @notice Binding is allocatable and active for reporting/unwinds.
        /// @dev New allocations are allowed and the strategy remains in active reads/unwind paths.
        Whitelisted,
        /// @notice Binding is no longer allocatable but remains active for defensive exits and reporting.
        /// @dev New allocations are blocked until exposure is drained or the pair is removed.
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
     *      be granted separately. Yield sweep recipient is configured independently and must not
     *      be the same as `admin`. Native bridge gateway is configured separately after deployment
     *      because it depends on the deployed vault proxy address.
     * @param admin                Initial governance admin account.
     * @param bridgeHub_           Initial BridgeHub address. Must be non-zero.
     * @param baseToken_           Initial mintable base token address. Must be non-zero.
     * @param l2ChainId_           Target L2 chain id. Must be non-zero.
     * @param l2ExchangeRecipient_ Initial L2 exchange recipient address. Must be non-zero.
     * @param wrappedNativeToken_  Canonical wrapped native token address. Must be non-zero.
     * @param yieldRecipient_      Initial yield recipient for native sweep flows. Must be non-zero and not `admin`.
     */
    function initialize(
        address admin,
        address bridgeHub_,
        address baseToken_,
        uint256 l2ChainId_,
        address l2ExchangeRecipient_,
        address wrappedNativeToken_,
        address yieldRecipient_
    ) external initializer {
        if (
            admin == address(0) ||
            bridgeHub_ == address(0) ||
            baseToken_ == address(0) ||
            l2ChainId_ == 0 ||
            l2ExchangeRecipient_ == address(0) ||
            wrappedNativeToken_ == address(0) ||
            yieldRecipient_ == address(0) ||
            yieldRecipient_ == admin
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
        _yieldRecipient = yieldRecipient_;
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

    /// @inheritdoc IL1TreasuryVault
    function hasRole(
        bytes32 role,
        address account
    ) public view override(AccessControlUpgradeable, IL1TreasuryVault) returns (bool) {
        return super.hasRole(role, account);
    }

    /// @inheritdoc IL1TreasuryVault
    function bridgeHub() external view override returns (address) {
        return _bridgeHub;
    }

    /// @inheritdoc IL1TreasuryVault
    function baseToken() external view override returns (address) {
        return _baseToken;
    }

    /// @inheritdoc IL1TreasuryVault
    function l2ChainId() external view override returns (uint256) {
        return _l2ChainId;
    }

    /// @inheritdoc IL1TreasuryVault
    function l2ExchangeRecipient() external view override returns (address) {
        return _l2ExchangeRecipient;
    }

    /// @inheritdoc IL1TreasuryVault
    function wrappedNativeToken() external view override returns (address) {
        return _wrappedNativeToken;
    }

    /// @inheritdoc IL1TreasuryVault
    function nativeBridgeGateway() external view override returns (address) {
        return _nativeBridgeGateway;
    }

    /// @inheritdoc IL1TreasuryVault
    function paused() external view override returns (bool) {
        return _paused;
    }

    /// @dev External ETH must not be sent directly to the vault.
    ///      This hook exists only for internal wrapped-native withdraw callbacks.
    receive() external payable {
        if (msg.sender != _wrappedNativeToken) revert InvalidParam();
    }

    /// @inheritdoc IL1TreasuryVault
    function yieldRecipient() external view override returns (address) {
        return _yieldRecipient;
    }

    /// @inheritdoc IL1TreasuryVault
    function yieldRecipientTimelockController() external view override returns (address) {
        return _yieldRecipientTimelockController;
    }

    /// @dev Reject unexpected calldata-bearing native sends.
    fallback() external payable {
        revert InvalidParam();
    }

    /// @inheritdoc IL1TreasuryVault
    function sweepNativeToYieldRecipient(uint256 amount) external override onlyVaultAdmin nonReentrant {
        if (amount == 0 || _yieldRecipient == address(0) || amount > address(this).balance) revert InvalidParam();
        VaultBridgeLib.sendNative(_yieldRecipient, amount);
        emit NativeSweptToYieldRecipient(_yieldRecipient, amount);
    }

    /// @inheritdoc IL1TreasuryVault
    function pause() external override onlyPauserOrAdmin {
        if (_paused) revert InvalidParam();
        _paused = true;
        emit VaultPaused(msg.sender);
    }

    /// @inheritdoc IL1TreasuryVault
    function unpause() external override onlyPauserOrAdmin {
        if (!_paused) revert InvalidParam();
        _paused = false;
        emit VaultUnpaused(msg.sender);
    }

    /// @inheritdoc IL1TreasuryVault
    function setYieldRecipientTimelockController(address newTimelock) external override onlyVaultAdmin {
        if (
            newTimelock == address(0) || newTimelock.code.length == 0 || _yieldRecipientTimelockController != address(0)
        ) {
            revert InvalidParam();
        }
        address previousTimelock = _yieldRecipientTimelockController;
        _yieldRecipientTimelockController = newTimelock;
        emit YieldRecipientTimelockControllerUpdated(previousTimelock, newTimelock);
    }

    /// @inheritdoc IL1TreasuryVault
    function setYieldRecipient(address newYieldRecipient) external override {
        address timelock = _yieldRecipientTimelockController;
        if (timelock == address(0)) revert YieldRecipientTimelockControllerNotSet();
        if (msg.sender != timelock) revert Unauthorized();
        if (
            newYieldRecipient == address(0) ||
            newYieldRecipient == _yieldRecipient ||
            newYieldRecipient == address(this)
        ) revert InvalidParam();
        address previousYieldRecipient = _yieldRecipient;
        _yieldRecipient = newYieldRecipient;
        emit YieldRecipientUpdated(previousYieldRecipient, newYieldRecipient);
    }

    /// @inheritdoc IL1TreasuryVault
    function setNativeBridgeGateway(address newNativeBridgeGateway) external override onlyVaultAdmin {
        if (
            newNativeBridgeGateway == address(0) ||
            newNativeBridgeGateway == address(this) ||
            newNativeBridgeGateway.code.length == 0
        ) revert InvalidParam();

        address previousNativeBridgeGateway = _nativeBridgeGateway;
        _nativeBridgeGateway = newNativeBridgeGateway;
        emit NativeBridgeGatewayUpdated(previousNativeBridgeGateway, newNativeBridgeGateway);
    }

    /// @inheritdoc IL1TreasuryVault
    function getVaultTokenConfig(address token) external view override returns (VaultTokenConfig memory) {
        return _vaultTokenConfigs[token];
    }

    /// @inheritdoc IL1TreasuryVault
    function getSupportedVaultTokens() external view override returns (address[] memory) {
        return _supportedVaultTokens;
    }

    /// @inheritdoc IL1TreasuryVault
    function isSupportedVaultToken(address vaultToken) external view override returns (bool) {
        _requireErc20Token(vaultToken);
        return _supportedVaultTokenSet[vaultToken];
    }

    /// @inheritdoc IL1TreasuryVault
    function setVaultTokenConfig(address token, VaultTokenConfig calldata cfg) external override onlyVaultAdmin {
        _requireErc20Token(token);
        (bool ok, ) = VaultStrategyOpsLib.tryBalanceOf(token, address(this));
        if (!ok) revert InvalidParam();
        _vaultTokenConfigs[token] = cfg;
        emit VaultTokenConfigUpdated(token, cfg);
        _syncSupportedVaultToken(token);
        _syncVaultTokenDirectTvlTracking(token);
    }

    /// @inheritdoc IL1TreasuryVault
    function isStrategyWhitelistedForVaultToken(address token, address strategy) external view override returns (bool) {
        _requireErc20Token(token);
        if (strategy == address(0)) revert InvalidParam();
        return _vaultTokenStrategyConfigs[token][strategy].whitelisted;
    }

    /// @inheritdoc IL1TreasuryVault
    function getVaultTokenStrategyConfig(
        address token,
        address strategy
    ) external view override returns (VaultTokenStrategyConfig memory) {
        _requireErc20Token(token);
        if (strategy == address(0)) revert InvalidParam();
        return _vaultTokenStrategyConfigs[token][strategy];
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev All strategy lifecycle transitions are centralized via `_setVaultTokenStrategyLifecycle`.
     */
    function setVaultTokenStrategyConfig(
        address token,
        address strategy,
        VaultTokenStrategyConfig calldata cfg
    ) external override onlyVaultAdmin {
        _requireErc20Token(token);
        if (strategy == address(0)) revert InvalidParam();
        if (cfg.whitelisted && !_vaultTokenConfigs[token].supported) revert TokenNotSupported();

        if (cfg.whitelisted) {
            _setVaultTokenStrategyLifecycle(token, strategy, StrategyLifecycle.Whitelisted, cfg.cap);
            return;
        }

        if (!_isActiveVaultTokenStrategy(token, strategy)) {
            _setVaultTokenStrategyLifecycle(token, strategy, StrategyLifecycle.NotRegistered, 0);
            return;
        }

        (bool ok, uint256 exposure) = VaultStrategyOpsLib.readStrategyExposure(token, strategy);
        bool canRemove = ok && exposure == 0;
        if (!ok) {
            emit StrategyRemovalCheckFailed(token, strategy);
        }
        _setVaultTokenStrategyLifecycle(
            token,
            strategy,
            canRemove ? StrategyLifecycle.NotRegistered : StrategyLifecycle.WithdrawOnly,
            canRemove ? 0 : cfg.cap
        );
    }

    /// @inheritdoc IL1TreasuryVault
    function refreshStrategyTvlTokens(address vaultToken, address strategy) external override onlyVaultAdmin {
        _requireErc20Token(vaultToken);
        if (strategy == address(0)) revert InvalidParam();
        if (!_isActiveVaultTokenStrategy(vaultToken, strategy)) revert StrategyNotWhitelisted();
        _refreshStrategyTvlTokens(vaultToken, strategy);
    }

    /// @inheritdoc IL1TreasuryVault
    function idleTokenBalance(address token) public view override returns (uint256) {
        (bool ok, uint256 balance) = VaultStrategyOpsLib.tryBalanceOf(token, address(this));
        if (!ok) return 0;
        return balance;
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Returns an empty component list if the strategy is not globally active.
     *      Strategy call failures are normalized to `InvalidStrategyTokenRead`.
     */
    function strategyPositionBreakdown(
        address vaultToken,
        address strategy
    ) external view override returns (PositionComponent[] memory components) {
        _requireErc20Token(vaultToken);
        if (strategy == address(0)) revert InvalidParam();
        if (!_isGloballyActiveStrategy(strategy)) return components;
        return VaultStrategyOpsLib.readStrategyPositionBreakdownOrRevert(vaultToken, strategy);
    }

    /// @inheritdoc IL1TreasuryVault
    function tokenTotals(address token) external view override returns (TokenTotals memory totals) {
        _requireErc20Token(token);

        totals.idle = idleTokenBalance(token);
        totals.total = totals.idle;

        address[] storage list = _activeStrategies;
        for (uint256 i = 0; i < list.length; ++i) {
            (bool ok, uint256 amount) = VaultStrategyOpsLib.readStrategyExactTokenBalance(token, list[i]);
            if (!ok) revert InvalidStrategyTokenRead(token, list[i]);
            if (amount > type(uint256).max - totals.strategy) {
                revert InvalidStrategyTokenRead(token, list[i]);
            }
            if (amount > type(uint256).max - totals.total) revert InvalidStrategyTokenRead(token, list[i]);
            totals.strategy += amount;
            totals.total += amount;
        }
    }

    /// @inheritdoc IL1TreasuryVault
    function strategyCostBasis(address token, address strategy) external view override returns (uint256) {
        _requireErc20Token(token);
        if (strategy == address(0)) revert InvalidParam();
        return _strategyCostBasis[token][strategy];
    }

    /// @inheritdoc IL1TreasuryVault
    function harvestableYield(address token, address strategy) public view override returns (uint256) {
        _requireErc20Token(token);
        if (strategy == address(0)) revert InvalidParam();
        if (!_canWithdrawVaultTokenFromStrategy(token, strategy)) return 0;
        uint256 exposure = VaultStrategyOpsLib.readStrategyExposureOrRevert(token, strategy);
        // Cost basis follows measured vault-side net decrease on allocate, not strategy receipt.
        // See README terminology for the worked examples behind this invariant.
        uint256 costBasis = _strategyCostBasis[token][strategy];
        uint256 effectiveCostBasis = costBasis < exposure ? costBasis : exposure;
        return exposure - effectiveCostBasis;
    }

    /// @inheritdoc IL1TreasuryVault
    function tokenTotalsConservative(
        address token
    ) external view override returns (ConservativeTokenTotals memory status) {
        _requireErc20Token(token);
        return _buildConservativeTokenTotals(token);
    }

    /// @inheritdoc IL1TreasuryVault
    function getTrackedTvlTokens() external view override returns (address[] memory) {
        return _trackedTvlTokens;
    }

    /// @inheritdoc IL1TreasuryVault
    function isTrackedTvlToken(address token) external view override returns (bool) {
        _requireErc20Token(token);
        return _trackedTvlTokenSet[token];
    }

    /// @inheritdoc IL1TreasuryVault
    function tokenTotalsBatch(
        address[] calldata tokens
    ) external view override returns (ConservativeTokenTotals[] memory statuses) {
        statuses = new ConservativeTokenTotals[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            _requireErc20Token(tokens[i]);
            statuses[i] = _buildConservativeTokenTotals(tokens[i]);
        }
    }

    /// @inheritdoc IL1TreasuryVault
    function trackedTvlTokenTotals()
        external
        view
        override
        returns (address[] memory tokens, ConservativeTokenTotals[] memory statuses)
    {
        uint256 len = _trackedTvlTokens.length;
        tokens = new address[](len);
        statuses = new ConservativeTokenTotals[](len);
        for (uint256 i = 0; i < len; ++i) {
            address token = _trackedTvlTokens[i];
            tokens[i] = token;
            statuses[i] = _buildConservativeTokenTotals(token);
        }
    }

    /// @inheritdoc IL1TreasuryVault
    function setTrackedTvlTokenOverride(address token, bool enabled, bool forceTrack) external override onlyVaultAdmin {
        _requireErc20Token(token);

        if (enabled) {
            _trackedTvlTokenOverrideEnabled[token] = true;
            _trackedTvlTokenOverrideValue[token] = forceTrack;
        } else {
            delete _trackedTvlTokenOverrideEnabled[token];
            delete _trackedTvlTokenOverrideValue[token];
        }

        emit TrackedTvlTokenOverrideUpdated(token, enabled, forceTrack);
        _reconcileTrackedTvlToken(token);
    }

    /**
     * @notice Shared immediate-availability helper.
     * @dev Returns 0 if the token is not supported. Otherwise returns the full idle token balance.
     */
    function _availableVaultTokenForRebalance(address vaultToken) internal view returns (uint256) {
        if (!_vaultTokenConfigs[vaultToken].supported) return 0;
        return idleTokenBalance(vaultToken);
    }

    /// @inheritdoc IL1TreasuryVault
    function availableNativeForRebalance() external view override returns (uint256) {
        return _availableVaultTokenForRebalance(_wrappedNativeToken);
    }

    /// @inheritdoc IL1TreasuryVault
    function availableErc20ForRebalance(address erc20Token) external view override returns (uint256) {
        if (erc20Token == _wrappedNativeToken) return 0;
        return _availableVaultTokenForRebalance(erc20Token);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Enforces in order:
     *      1. Token is supported (`VaultTokenConfig.supported == true`).
     *      2. Strategy is whitelisted (`VaultTokenStrategyConfig.whitelisted == true`).
     *      3. If `VaultTokenStrategyConfig.cap != 0`, the strategy's existing strategy exposure
     *         plus `amount` must not exceed the cap. The cap check reads
     *         `strategy.strategyExposure(token)`.
     *
     *      Approval pattern: the vault grants an exact `amount` allowance to `strategy`,
     *      calls `strategy.allocate`, then resets the allowance to 0. This minimises residual
     *      approval exposure in case the strategy does not consume the full allowance.
     *
     *      Cost-basis policy: tracked cost basis increases by measured vault-side net token balance
     *      decrease during `allocate`, not by strategy receipt. Same-call token returns back to the
     *      vault reduce the tracked spend by design. See README terminology for the rationale.
     *
     *      This function is blocked when the vault is paused.
     */
    function allocateVaultTokenToStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external override nonReentrant whenNotPaused onlyAllocator {
        _requireErc20Token(token);
        if (strategy == address(0) || amount == 0) revert InvalidParam();

        if (!_vaultTokenConfigs[token].supported) revert TokenNotSupported();
        VaultTokenStrategyConfig storage sCfg = _vaultTokenStrategyConfigs[token][strategy];
        if (!sCfg.whitelisted) revert StrategyNotWhitelisted();

        uint256 idle = idleTokenBalance(token);
        if (idle < amount) revert InvalidParam();

        if (sCfg.cap != 0) {
            uint256 current = VaultStrategyOpsLib.readStrategyExposureOrRevert(token, strategy);
            if (current > type(uint256).max - amount || current + amount > sCfg.cap) revert CapExceeded();
        }

        IERC20(token).forceApprove(strategy, amount);
        uint256 spent = VaultStrategyOpsLib.allocateWithBalanceDelta(token, strategy, amount);
        IERC20(token).forceApprove(strategy, 0);
        _increaseStrategyCostBasis(token, strategy, spent);
        if (spent != amount) {
            emit VaultTokenAllocationSpentMismatch(token, strategy, amount, spent);
        }
        emit VaultTokenAllocatedToStrategy(token, strategy, amount);
        _syncVaultTokenDirectTvlTracking(token);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Callable while paused and when token support is removed (defensive exit).
     *
     *      Authorization: requires the strategy to be either whitelisted OR still present in
     *      `_vaultTokenStrategies` (withdraw-only mode). This allows recovery from strategies that
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
    function deallocateVaultTokenFromStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external override nonReentrant onlyAllocatorOrAdmin returns (uint256 received) {
        _requireErc20Token(token);
        if (strategy == address(0) || amount == 0) revert InvalidParam();
        if (!_canWithdrawVaultTokenFromStrategy(token, strategy)) revert StrategyNotWhitelisted();
        (uint256 reported, uint256 measured) = VaultStrategyOpsLib.deallocateWithBalanceDelta(
            token,
            strategy,
            amount,
            false
        );
        received = _finalizeDeallocation(token, strategy, amount, reported, measured, true, true);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Callable while paused and when token support is removed (defensive exit).
     *
     *      Equivalent to `deallocateVaultTokenFromStrategy` but calls `strategy.deallocateAll` instead of
     *      `strategy.deallocate`. Uses `type(uint256).max` as the `requested` field in events to
     *      signal an uncapped unwind.
     *
     *      Accounting: same balance-delta approach as `deallocateVaultTokenFromStrategy`. Mismatch between
     *      strategy-reported and measured received amount triggers `StrategyReportedReceivedMismatch`.
     */
    function deallocateAllVaultTokenFromStrategy(
        address token,
        address strategy
    ) external override nonReentrant onlyAllocatorOrAdmin returns (uint256 received) {
        _requireErc20Token(token);
        if (strategy == address(0)) revert InvalidParam();
        if (!_canWithdrawVaultTokenFromStrategy(token, strategy)) revert StrategyNotWhitelisted();
        (uint256 reported, uint256 measured) = VaultStrategyOpsLib.deallocateWithBalanceDelta(
            token,
            strategy,
            type(uint256).max,
            true
        );
        received = _finalizeDeallocation(token, strategy, type(uint256).max, reported, measured, true, true);
    }

    /**
     * @notice Harvests strategy yield and pays proceeds to configured yield recipient.
     * @dev Callable by `VAULT_ADMIN_ROLE` and blocked while paused.
     *      Harvest deallocates from strategy without changing tracked cost basis, then pays yield recipient:
     *      ERC20 for non-wrapped-native vault tokens, native ETH for wrapped-native vault tokens.
     * @param token Vault token (ERC20).
     * @param strategy Strategy source.
     * @param amount Requested harvest amount from strategy.
     * @param minReceived Minimum net amount that must reach yield recipient.
     * @return received Net amount received by yield recipient.
     */
    function harvestYieldFromStrategy(
        address token,
        address strategy,
        uint256 amount,
        uint256 minReceived
    ) external override nonReentrant whenNotPaused onlyVaultAdmin returns (uint256 received) {
        _requireErc20Token(token);
        if (strategy == address(0) || amount == 0) revert InvalidParam();
        if (!_canWithdrawVaultTokenFromStrategy(token, strategy)) revert StrategyNotWhitelisted();

        address recipient = _yieldRecipient;
        if (recipient == address(0)) revert InvalidParam();

        uint256 maxYield = harvestableYield(token, strategy);
        if (maxYield == 0 || amount > maxYield) revert YieldNotAvailable();

        (uint256 reported, uint256 withdrawnToVault) = VaultStrategyOpsLib.deallocateWithBalanceDelta(
            token,
            strategy,
            amount,
            false
        );
        withdrawnToVault = _finalizeDeallocation(token, strategy, amount, reported, withdrawnToVault, false, false);
        if (withdrawnToVault > maxYield) revert YieldNotAvailable();

        received = VaultStrategyOpsLib.payoutHarvestProceeds(token, _wrappedNativeToken, recipient, withdrawnToVault);
        if (received < minReceived) revert SlippageExceeded();
        emit YieldHarvested(token, strategy, recipient, amount, received);
        // Harvest first deallocates into vault idle, then pays yield recipient.
        // Sync after payout so unsupported vault tokens can untrack when exposure reaches zero.
        _syncVaultTokenDirectTvlTracking(token);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Enforces standard rebalance policy for native path. Blocked when paused.
     */
    function rebalanceNativeToL2(uint256 amount) external payable override nonReentrant whenNotPaused onlyRebalancer {
        if (msg.value != 0) revert InvalidParam();
        _dispatchBridgeOutToL2(_wrappedNativeToken, amount, true, false);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Enforces standard rebalance policy for ERC20 path. Blocked when paused.
     */
    function rebalanceErc20ToL2(
        address erc20Token,
        uint256 amount
    ) external payable override nonReentrant whenNotPaused onlyRebalancer {
        if (msg.value != 0) revert InvalidParam();
        if (erc20Token == _wrappedNativeToken) revert InvalidParam();
        _dispatchBridgeOutToL2(erc20Token, amount, false, false);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Bypass mode: skips pause check and support checks.
     *
     *      Auto-unwind: if wrapped-native idle balance is less than `amount`, the function iterates
     *      `_vaultTokenStrategies[_wrappedNativeToken]` and pulls funds from each strategy via best-effort
     *      `try/catch` deallocate calls until the shortfall is covered or all strategies are
     *      exhausted. Strategies that revert or return a decreased balance are skipped with an
     *      `EmergencyStrategySkipped` event. If the balance is still insufficient after the full
     *      iteration, the call reverts.
     */
    function emergencyNativeToL2(uint256 amount) external payable override nonReentrant onlyRebalancerOrAdmin {
        if (msg.value != 0) revert InvalidParam();
        _dispatchBridgeOutToL2(_wrappedNativeToken, amount, true, true);
    }

    /**
     * @inheritdoc IL1TreasuryVault
     * @dev Bypass mode: skips pause check and support checks.
     *
     *      Auto-unwind: if vault idle balance is less than `amount`, the function iterates
     *      `_vaultTokenStrategies[erc20Token]` and pulls funds from each strategy via best-effort
     *      `try/catch` deallocate calls until the shortfall is covered or all strategies are
     *      exhausted. Strategies that revert or return a decreased balance are skipped with an
     *      `EmergencyStrategySkipped` event. If the balance is still insufficient after the full
     *      iteration, the call reverts.
     */
    function emergencyErc20ToL2(
        address erc20Token,
        uint256 amount
    ) external payable override nonReentrant onlyRebalancerOrAdmin {
        if (msg.value != 0) revert InvalidParam();
        if (erc20Token == _wrappedNativeToken) revert InvalidParam();
        _dispatchBridgeOutToL2(erc20Token, amount, false, true);
    }

    /**
     * @notice Returns the current active strategy list for a token.
     * @dev Includes withdraw-only strategies that still hold a position (pending full removal).
     *      The array length is bounded by `MAX_STRATEGIES_PER_TOKEN`.
     * @param token The ERC20 token address.
     * @return Array of strategy addresses currently tracked for `token`.
     */
    function getVaultTokenStrategies(address token) external view override returns (address[] memory) {
        return _vaultTokenStrategies[token];
    }

    /**
     * @notice Applies shared post-deallocation accounting and telemetry.
     * @dev Optionally reduces tracked cost basis and optionally re-syncs direct vault-token TVL tracking,
     *      allowing harvest and emergency unwind paths to reuse the same measured-delta finalizer.
     * @param token Vault token being deallocated.
     * @param strategy Strategy source.
     * @param requested Amount requested from the strategy.
     * @param reported Amount self-reported by the strategy.
     * @param received Amount actually measured back at the vault.
     * @param reduceCostBasis True to reduce tracked cost basis by `received`.
     * @param syncTokenTracking True to re-run direct vault-token TVL tracking sync.
     * @return The measured `received` amount.
     */
    function _finalizeDeallocation(
        address token,
        address strategy,
        uint256 requested,
        uint256 reported,
        uint256 received,
        bool reduceCostBasis,
        bool syncTokenTracking
    ) internal returns (uint256) {
        if (reported != received) {
            emit StrategyReportedReceivedMismatch(token, strategy, requested, reported, received);
        }
        if (reduceCostBasis) _decreaseStrategyCostBasis(token, strategy, received);
        emit VaultTokenDeallocatedFromStrategy(token, strategy, requested, received);
        if (syncTokenTracking) _syncVaultTokenDirectTvlTracking(token);
        return received;
    }

    /**
     * @notice Adds a supported vault token to the supported-vault-token registry.
     * @param vaultToken Vault token to add.
     */
    function _addSupportedVaultToken(address vaultToken) internal {
        if (_supportedVaultTokenSet[vaultToken]) return;
        _supportedVaultTokens.push(vaultToken);
        _supportedVaultTokenSet[vaultToken] = true;
    }

    /**
     * @notice Removes a supported vault token from the supported-vault-token registry using swap-pop.
     * @dev No-op when the token is not currently tracked.
     * @param vaultToken Vault token to remove.
     */
    function _removeSupportedVaultToken(address vaultToken) internal {
        if (!_supportedVaultTokenSet[vaultToken]) return;
        uint256 removeIndex = type(uint256).max;
        for (uint256 i = 0; i < _supportedVaultTokens.length; ++i) {
            if (_supportedVaultTokens[i] == vaultToken) {
                removeIndex = i;
                break;
            }
        }
        if (removeIndex == type(uint256).max) return;

        uint256 lastIndex = _supportedVaultTokens.length - 1;
        if (removeIndex != lastIndex) {
            _supportedVaultTokens[removeIndex] = _supportedVaultTokens[lastIndex];
        }
        _supportedVaultTokens.pop();
        delete _supportedVaultTokenSet[vaultToken];
    }

    /**
     * @notice Reconciles one vault token in the supported-vault-token registry.
     * @param vaultToken Vault token to reconcile.
     */
    function _syncSupportedVaultToken(address vaultToken) internal {
        bool shouldTrack = _vaultTokenConfigs[vaultToken].supported;
        bool currentlyTracked = _supportedVaultTokenSet[vaultToken];
        if (shouldTrack && !currentlyTracked) {
            _addSupportedVaultToken(vaultToken);
            return;
        }
        if (!shouldTrack && currentlyTracked) {
            _removeSupportedVaultToken(vaultToken);
        }
    }

    /**
     * @notice Adds a token to the tracked TVL-token registry if it is not already present.
     * @param token TVL token to add.
     */
    function _addTrackedTvlToken(address token) internal {
        if (_trackedTvlTokenSet[token]) return;
        _trackedTvlTokens.push(token);
        _trackedTvlTokenSet[token] = true;
    }

    /**
     * @notice Removes a token from the tracked TVL-token registry using swap-pop.
     * @dev No-op when the token is not currently tracked.
     * @param token TVL token to remove.
     */
    function _removeTrackedTvlToken(address token) internal {
        if (!_trackedTvlTokenSet[token]) return;
        uint256 removeIndex = type(uint256).max;
        for (uint256 i = 0; i < _trackedTvlTokens.length; ++i) {
            if (_trackedTvlTokens[i] == token) {
                removeIndex = i;
                break;
            }
        }
        if (removeIndex == type(uint256).max) return;

        uint256 lastIndex = _trackedTvlTokens.length - 1;
        if (removeIndex != lastIndex) {
            _trackedTvlTokens[removeIndex] = _trackedTvlTokens[lastIndex];
        }
        _trackedTvlTokens.pop();
        delete _trackedTvlTokenSet[token];
    }

    /**
     * @notice Reconciles whether a token should remain in the tracked TVL-token registry.
     * @dev Tracking is driven by cached refs and optional admin override.
     * @param token TVL token to reconcile.
     */
    function _reconcileTrackedTvlToken(address token) internal {
        bool shouldTrack = _trackedTvlTokenRefCount[token] != 0;
        bool currentlyTracked = _trackedTvlTokenSet[token];
        if (_trackedTvlTokenOverrideEnabled[token]) shouldTrack = _trackedTvlTokenOverrideValue[token];
        if (shouldTrack && !currentlyTracked) {
            _addTrackedTvlToken(token);
            return;
        }
        if (!shouldTrack && currentlyTracked) {
            _removeTrackedTvlToken(token);
        }
    }

    /**
     * @notice Increments tracked TVL-token refcount for `token`.
     */
    function _incrementTrackedTvlTokenRef(address token) internal {
        unchecked {
            ++_trackedTvlTokenRefCount[token];
        }
        _reconcileTrackedTvlToken(token);
    }

    /**
     * @notice Decrements tracked TVL-token refcount for `token` without underflow.
     */
    function _decrementTrackedTvlTokenRef(address token) internal {
        uint256 refs = _trackedTvlTokenRefCount[token];
        if (refs == 0) return;
        if (refs == 1) {
            delete _trackedTvlTokenRefCount[token];
        } else {
            _trackedTvlTokenRefCount[token] = refs - 1;
        }
        _reconcileTrackedTvlToken(token);
    }

    /**
     * @notice Reconciles the direct vault-token TVL contribution for `vaultToken`.
     * @dev The vault token itself remains a tracked TVL token while supported or while idle balance remains.
     */
    function _syncVaultTokenDirectTvlTracking(address vaultToken) internal {
        bool shouldTrack = _vaultTokenConfigs[vaultToken].supported || idleTokenBalance(vaultToken) != 0;
        bool currentlyTracked = _vaultTokenDirectTvlTracked[vaultToken];
        if (shouldTrack == currentlyTracked) return;
        _vaultTokenDirectTvlTracked[vaultToken] = shouldTrack;
        if (shouldTrack) {
            _incrementTrackedTvlTokenRef(vaultToken);
            return;
        }
        _decrementTrackedTvlTokenRef(vaultToken);
    }

    /**
     * @notice Reads and validates the declared TVL-token list from `strategy` for `vaultToken`.
     */
    function _readStrategyTvlTokens(
        address vaultToken,
        address strategy
    ) internal view returns (address[] memory tokens) {
        try IYieldStrategy(strategy).tvlTokens(vaultToken) returns (address[] memory data) {
            tokens = data;
        } catch {
            tokens = new address[](1);
            tokens[0] = vaultToken;
            return tokens;
        }
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert InvalidParam();
            for (uint256 j = i + 1; j < tokens.length; ++j) {
                if (tokens[i] == tokens[j]) revert InvalidParam();
            }
        }
    }

    /**
     * @notice Clears the cached TVL-token list for one active `(vaultToken, strategy)` pair.
     */
    function _clearStrategyTvlTokens(address vaultToken, address strategy) internal {
        address[] storage cached = _cachedStrategyTvlTokens[vaultToken][strategy];
        for (uint256 i = 0; i < cached.length; ++i) {
            _decrementTrackedTvlTokenRef(cached[i]);
        }
        delete _cachedStrategyTvlTokens[vaultToken][strategy];
    }

    /**
     * @notice Replaces the cached TVL-token list for one active `(vaultToken, strategy)` pair.
     */
    function _setStrategyTvlTokens(address vaultToken, address strategy, address[] memory tokens) internal {
        address[] storage cached = _cachedStrategyTvlTokens[vaultToken][strategy];
        for (uint256 i = 0; i < cached.length; ++i) {
            _decrementTrackedTvlTokenRef(cached[i]);
        }
        delete _cachedStrategyTvlTokens[vaultToken][strategy];

        address[] storage target = _cachedStrategyTvlTokens[vaultToken][strategy];
        for (uint256 i = 0; i < tokens.length; ++i) {
            target.push(tokens[i]);
            _incrementTrackedTvlTokenRef(tokens[i]);
        }
    }

    /**
     * @notice Refreshes the cached TVL-token list for one active `(vaultToken, strategy)` pair.
     */
    function _refreshStrategyTvlTokens(address vaultToken, address strategy) internal {
        _setStrategyTvlTokens(vaultToken, strategy, _readStrategyTvlTokens(vaultToken, strategy));
    }

    function _setVaultTokenStrategyLifecycle(
        address token,
        address strategy,
        StrategyLifecycle lifecycle,
        uint256 cap
    ) internal {
        if (lifecycle == StrategyLifecycle.NotRegistered) {
            if (_isActiveVaultTokenStrategy(token, strategy)) {
                _clearStrategyTvlTokens(token, strategy);
                _removeVaultTokenStrategy(token, strategy);
            }
            delete _vaultTokenStrategyConfigs[token][strategy];
            delete _strategyCostBasis[token][strategy];
            emit VaultTokenStrategyConfigUpdated(token, strategy, false, 0);
            _syncVaultTokenDirectTvlTracking(token);
            return;
        }

        if (!_isActiveVaultTokenStrategy(token, strategy)) {
            _addVaultTokenStrategy(token, strategy);
            _refreshStrategyTvlTokens(token, strategy);
        }
        VaultTokenStrategyConfig storage current = _vaultTokenStrategyConfigs[token][strategy];
        current.whitelisted = lifecycle == StrategyLifecycle.Whitelisted;
        current.active = true;
        current.cap = cap;
        emit VaultTokenStrategyConfigUpdated(token, strategy, current.whitelisted, cap);
        _syncVaultTokenDirectTvlTracking(token);
    }

    /**
     * @notice Executes shared bridge-out flow for rebalance and emergency operations.
     * @param token Vault token (always ERC20 inside strategy calls).
     * @param amount Amount to bridge to L2.
     * @param isNativeIntent True for native branch (`token` must be wrapped-native).
     * @param emergency True for emergency mode (supports disabled, pause-bypass behavior).
     */
    function _dispatchBridgeOutToL2(address token, uint256 amount, bool isNativeIntent, bool emergency) internal {
        VaultBridgeLib.BridgeRequest memory request = VaultBridgeLib.BridgeRequest({
            bridgeHub: _bridgeHub,
            baseToken: _baseToken,
            l2ChainId: _l2ChainId,
            l2ExchangeRecipient: _l2ExchangeRecipient,
            wrappedNativeToken: _wrappedNativeToken,
            l2TxGasLimit: L2_TX_GAS_LIMIT,
            l2TxGasPerPubdataByte: L2_TX_GAS_PER_PUBDATA_BYTE,
            token: token,
            amount: amount,
            isNativeIntent: isNativeIntent
        });

        VaultBridgeLib.EmergencyUnwindStep[] memory steps;
        if (emergency) {
            steps = VaultBridgeLib.prepareEmergencyBridgeOut(request, _vaultTokenStrategies[token]);
            _finalizeEmergencyUnwind(token, steps);
        } else {
            VaultBridgeLib.ensureStandardBridgeOut(request, _vaultTokenConfigs[token].supported);
        }

        bytes32 txHash = isNativeIntent
            ? _bridgeNativeToL2ThroughGateway(amount)
            : VaultBridgeLib.bridgeToL2TwoBridges(request);
        VaultBridgeLib.emitBridgeEvent(
            token,
            amount,
            L2_TX_GAS_LIMIT,
            L2_TX_GAS_PER_PUBDATA_BYTE,
            _l2ExchangeRecipient,
            txHash,
            isNativeIntent,
            emergency
        );
        _syncVaultTokenDirectTvlTracking(token);
    }

    /**
     * @notice Bridges wrapped-native to L2 through the configured native bridge gateway.
     * @dev The vault mints base token to itself, transfers wrapped-native and base token into the gateway,
     *      and lets the gateway become the zkSync deposit sender so failed native deposits can be reclaimed
     *      without sending ETH directly back to the vault.
     * @param amount Wrapped-native amount to bridge as native ETH.
     * @return txHash Canonical L2 transaction hash returned by BridgeHub.
     */
    function _bridgeNativeToL2ThroughGateway(uint256 amount) internal returns (bytes32 txHash) {
        address gateway = _nativeBridgeGateway;
        if (gateway == address(0)) revert NativeBridgeGatewayNotSet();

        uint256 baseCost = IL1ZkSyncBridgeHub(_bridgeHub).l2TransactionBaseCost(
            _l2ChainId,
            tx.gasprice,
            L2_TX_GAS_LIMIT,
            L2_TX_GAS_PER_PUBDATA_BYTE
        );

        IGRVTBaseTokenMintable(_baseToken).mint(address(this), baseCost);
        IERC20(_wrappedNativeToken).safeTransfer(gateway, amount);
        IERC20(_baseToken).safeTransfer(gateway, baseCost);

        txHash = INativeBridgeGateway(gateway).bridgeNativeToL2(
            _l2ChainId,
            L2_TX_GAS_LIMIT,
            L2_TX_GAS_PER_PUBDATA_BYTE,
            _l2ExchangeRecipient,
            _l2ExchangeRecipient,
            amount,
            baseCost
        );
    }

    /**
     * @notice Increases tracked cost basis by `delta`.
     * @param token Vault token for position.
     * @param strategy Strategy address.
     * @param delta Cost-basis increment amount.
     */
    function _increaseStrategyCostBasis(address token, address strategy, uint256 delta) internal {
        if (delta == 0) return;
        uint256 previousCostBasis = _strategyCostBasis[token][strategy];
        uint256 newCostBasis = previousCostBasis + delta;
        _strategyCostBasis[token][strategy] = newCostBasis;
    }

    /**
     * @notice Decreases tracked cost basis by up to `delta`.
     * @dev Decrease is capped at current cost basis and never underflows.
     * @param token Vault token for position.
     * @param strategy Strategy address.
     * @param delta Requested cost basis decrement amount.
     */
    function _decreaseStrategyCostBasis(address token, address strategy, uint256 delta) internal {
        if (delta == 0) return;
        uint256 previousCostBasis = _strategyCostBasis[token][strategy];
        if (previousCostBasis == 0) return;
        uint256 decreaseBy = delta < previousCostBasis ? delta : previousCostBasis;
        uint256 newCostBasis = previousCostBasis - decreaseBy;
        _strategyCostBasis[token][strategy] = newCostBasis;
    }

    /**
     * @notice Returns true if `strategy` is present in the active strategy list for `token`.
     * @dev Membership is tracked directly in `VaultTokenStrategyConfig.active` for O(1) checks.
     *      This avoids scanning `_vaultTokenStrategies[token]` at each authorization/read call site.
     */
    function _isActiveVaultTokenStrategy(address token, address strategy) internal view returns (bool) {
        return _vaultTokenStrategyConfigs[token][strategy].active;
    }

    /**
     * @notice Returns true when a strategy is active under at least one vault token.
     */
    function _isGloballyActiveStrategy(address strategy) internal view returns (bool) {
        return _activeStrategyRefCount[strategy] != 0;
    }

    /**
     * @notice Returns true if funds may be withdrawn from `strategy` for `token`.
     * @dev Withdrawal is permitted when the strategy is either:
     *      - Whitelisted (`VaultTokenStrategyConfig.whitelisted == true`), OR
     *      - Active (present in `_vaultTokenStrategies`) — i.e. in withdraw-only mode.
     *
     *      This keeps the deallocation path resilient during de-whitelist transitions: allocation
     *      permission can be revoked immediately (`whitelisted = false`) while existing positions
     *      remain withdrawable until fully drained (`active = true` until removal).
     */
    function _canWithdrawVaultTokenFromStrategy(address token, address strategy) internal view returns (bool) {
        VaultTokenStrategyConfig storage cfg = _vaultTokenStrategyConfigs[token][strategy];
        return cfg.whitelisted || cfg.active;
    }

    /**
     * @notice Finalizes emergency unwind steps returned by the bridge library.
     * @dev Emits skip telemetry for failed steps and applies the shared deallocation finalizer to successful ones
     *      without re-running tracked-TVL-token reconciliation on every loop iteration.
     * @param token Vault token being unwound.
     * @param steps Per-strategy unwind results returned by `VaultBridgeLib`.
     */
    function _finalizeEmergencyUnwind(address token, VaultBridgeLib.EmergencyUnwindStep[] memory steps) internal {
        for (uint256 i = 0; i < steps.length; ++i) {
            VaultBridgeLib.EmergencyUnwindStep memory step = steps[i];
            if (step.strategy == address(0)) continue;
            if (step.skipped) {
                emit EmergencyStrategySkipped(token, step.strategy);
                continue;
            }
            if (step.request == 0) continue;
            _finalizeDeallocation(token, step.strategy, step.request, step.reported, step.got, true, false);
        }
    }

    /**
     * @notice Appends `strategy` to the active strategy list for `token`.
     * @dev Reverts with `CapExceeded` if `_vaultTokenStrategies[token].length == MAX_STRATEGIES_PER_TOKEN`.
     *      Caller must ensure `strategy` is not already active for `token`.
     */
    function _addVaultTokenStrategy(address token, address strategy) internal {
        if (_isActiveVaultTokenStrategy(token, strategy)) revert InvalidParam();
        address[] storage list = _vaultTokenStrategies[token];
        if (list.length >= MAX_STRATEGIES_PER_TOKEN) revert CapExceeded();
        list.push(strategy);
        _vaultTokenStrategyConfigs[token][strategy].active = true;
        _increaseGlobalActiveStrategy(strategy);
    }

    /**
     * @notice Removes `strategy` from the active strategy list for `token` using swap-pop.
     * @dev No-op if `strategy` is not present.
     *
     *      Since list length is bounded by `MAX_STRATEGIES_PER_TOKEN`, a linear scan is used
     *      to find the index, followed by standard swap-pop removal.
     *
     *      Order of elements in `_vaultTokenStrategies` is not preserved, which is acceptable
     *      because all consumers treat it as an unordered set.
     */
    function _removeVaultTokenStrategy(address token, address strategy) internal {
        address[] storage list = _vaultTokenStrategies[token];
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
        _vaultTokenStrategyConfigs[token][strategy].active = false;
        _decreaseGlobalActiveStrategy(strategy);
    }

    /**
     * @notice Increments global active-reference count for `strategy`.
     * @dev Adds strategy to `_activeStrategies` on first active token pair.
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
     * @dev Removes strategy from `_activeStrategies` when no active token pairs remain.
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

    /**
     * @notice Builds best-effort totals for one exact TVL token.
     * @dev Scans global active strategies so non-underlying component-token queries are complete.
     * Invalid exact-token balance reads are skipped and counted.
     */
    function _buildConservativeTokenTotals(
        address token
    ) internal view returns (ConservativeTokenTotals memory status) {
        status.idle = idleTokenBalance(token);
        status.total = status.idle;

        address[] storage list = _activeStrategies;
        for (uint256 i = 0; i < list.length; ++i) {
            (bool ok, uint256 amount) = VaultStrategyOpsLib.readStrategyExactTokenBalance(token, list[i]);
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
     * @notice Validates token input for ERC20-only APIs.
     * @dev Token-domain vault APIs never use `address(0)` as a native ETH sentinel.
     *      Native ETH uses explicit entrypoints such as `rebalanceNativeToL2`.
     */
    function _requireErc20Token(address token) internal pure {
        if (token == address(0)) revert InvalidParam();
    }
}
