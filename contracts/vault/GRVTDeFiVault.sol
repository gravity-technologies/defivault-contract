// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IExchangeBridgeAdapter} from "../interfaces/IExchangeBridgeAdapter.sol";
import {IL1DefiVault} from "../interfaces/IL1DefiVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

/**
 * @title GRVTDeFiVault
 * @notice Upgradeable L1 treasury vault for GRVT that manages three flows:
 *         (1) hold idle ERC20 liquidity,
 *         (2) allocate/deallocate via whitelisted yield strategies, and
 *         (3) bridge idle liquidity to a fixed L2 exchange recipient via a configured adapter.
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
 *         `idleReserve` in `TokenConfig` sets a minimum floor that may not be bridged or allocated.
 *
 *      2. **Yield strategies** – ALLOCATOR pushes idle funds into whitelisted `IYieldStrategy`
 *         contracts (e.g. Aave V3). Balance accounting always uses on-chain balance deltas on
 *         the return path, not strategy-reported values, to defend against incorrect return data.
 *
 *      3. **L1 → L2 bridge** – REBALANCER calls `rebalanceToL2`, which enforces per-token rate
 *         limits and a per-tx cap before forwarding funds to `IExchangeBridgeAdapter.sendToL2`.
 *         The adapter handles the zkSync-specific bridge mechanics. ETH bridge fees are passed
 *         through as `msg.value`; no internal buffering occurs.
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
 *        1. **Not registered** – `_strategyIndexPlusOne == 0`, config zeroed.
 *        2. **Whitelisted** – `cfg.whitelisted == true`, present in `_tokenStrategies`.
 *           Allocation is permitted up to `cfg.cap` (if non-zero).
 *        3. **Withdraw-only** – `cfg.whitelisted == false` but still present in `_tokenStrategies`
 *           because the strategy still holds funds. Allocation is blocked; deallocation is allowed.
 *        4. **Removed** – strategy is absent from `_tokenStrategies` and config is deleted.
 *           Reached when `IYieldStrategy.assets(token)` returns 0 at de-whitelist time, or
 *           after a full manual deallocation.
 *
 *      Transition from (2) to (3)/(4) is triggered by calling `whitelistStrategy` with
 *      `cfg.whitelisted == false`. The vault immediately enters withdraw-only mode and probes
 *      `strategy.assets(token)` to decide whether it can advance to (4) in the same call.
 *
 *      ### Accounting fault tolerance
 *      `totalAssets` / `totalAssetsStatus` iterate all active strategies with `try/catch`.
 *      A failing strategy is silently skipped and counted in `skippedStrategies`. Callers
 *      should treat a non-zero `skippedStrategies` as a degraded-mode signal.
 *
 *      ### Emergency unwind
 *      `emergencySendToL2` bypasses normal rebalance policy (no rate limit, no `idleReserve`
 *      floor, no per-tx cap, callable while paused). If idle funds are insufficient it
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

    /// @notice Maximum number of strategies that can be simultaneously registered for a single token.
    /// @dev Bounds the gas cost of `emergencySendToL2` strategy iteration and prevents unbounded loops.
    uint256 public constant MAX_STRATEGIES_PER_TOKEN = 8;

    // ============================================= Storage (Private) ==============================================

    /// @dev L1 bridge/custody adapter used for outbound L1 → L2 transfers.
    address private _bridgeAdapter;

    /// @dev Canonical L2 exchange recipient for top-ups and emergency sends.
    address private _l2ExchangeRecipient;

    /// @dev Global pause flag. When true, blocks `allocateToStrategy` and `rebalanceToL2`.
    bool private _paused;

    /// @dev Per-token support and risk-control parameters (idleReserve, caps, delay).
    mapping(address token => TokenConfig cfg) private _tokenConfigs;

    // Strategy registry — three synchronized data structures:
    //
    // 1. `_strategyConfigs[token][strategy]`
    //    Source of truth for (token, strategy) authorization: whitelisted flag, cap, and tag.
    //    Consulted by allocation/deallocation authorization checks.
    //
    // 2. `_tokenStrategies[token]`
    //    Enumerable strategy list for a token; iterated by `totalAssets` and emergency unwinds.
    //    Contains both whitelisted and withdraw-only strategies (those with remaining positions).
    //
    // 3. `_strategyIndexPlusOne[token][strategy]`
    //    Reverse index (index + 1) into `_tokenStrategies`, enabling O(1) membership tests and
    //    swap-pop removal without a linear scan.
    //
    // Invariant:
    //   idx = _strategyIndexPlusOne[token][strategy]
    //   idx == 0  ⟹  strategy is NOT in _tokenStrategies[token]
    //   idx  > 0  ⟹  _tokenStrategies[token][idx - 1] == strategy
    mapping(address token => mapping(address strategy => StrategyConfig cfg)) private _strategyConfigs;
    mapping(address token => address[] strategies) private _tokenStrategies;
    mapping(address token => mapping(address strategy => uint256 indexPlusOne)) private _strategyIndexPlusOne;

    /// @dev Per-token timestamp of the latest successful `rebalanceToL2` call (not `emergencySendToL2`).
    mapping(address token => uint64 lastTs) private _lastRebalanceAt;

    /// @dev Reserved storage gap for upgrade-safe layout extension (50 × 32 bytes).
    uint256[50] private __gap;

    // =============================================== Events ===================================================

    /// @notice Emitted when the bridge adapter address is changed.
    event BridgeAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);

    /// @notice Emitted when the L2 exchange recipient address is changed.
    event L2ExchangeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    /// @notice Emitted when the vault enters the paused state.
    event VaultPaused(address indexed account);

    /// @notice Emitted when the vault leaves the paused state.
    event VaultUnpaused(address indexed account);

    /// @notice Emitted when a token's `TokenConfig` is set or updated.
    event TokenConfigUpdated(address indexed token, TokenConfig cfg);

    /**
     * @notice Emitted when a strategy's whitelist status for a token changes.
     * @param whitelisted  True when the strategy is being (re-)whitelisted; false when removed or de-listed.
     * @param cap          The allocation cap in effect after the update (0 = unlimited).
     * @param tag          The strategy identifier tag after the update (e.g. "AAVE_V3").
     */
    event StrategyWhitelistUpdated(
        address indexed token,
        address indexed strategy,
        bool whitelisted,
        uint256 cap,
        bytes32 tag
    );

    /**
     * @notice Emitted during `emergencySendToL2` when a strategy's funds cannot be retrieved.
     * @dev Skipping is non-fatal; the emergency flow continues with the next strategy.
     *      Causes include: `assets()` revert, `deallocate()` revert, or balance decreased after call.
     */
    event EmergencyStrategySkipped(address indexed token, address indexed strategy);

    /**
     * @notice Emitted during `whitelistStrategy` de-listing when the `assets()` probe call reverts.
     * @dev The strategy remains in withdraw-only mode (still in `_tokenStrategies`) until its
     *      balance reaches zero and `whitelistStrategy` is called again to complete removal.
     */
    event StrategyRemovalCheckFailed(address indexed token, address indexed strategy);

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
     * @param bridgeAdapter_       Initial bridge adapter used for L1 → L2 sends. Must be non-zero.
     * @param l2ExchangeRecipient_ Initial L2 exchange recipient address. Must be non-zero.
     */
    function initialize(address admin, address bridgeAdapter_, address l2ExchangeRecipient_) external initializer {
        if (admin == address(0) || bridgeAdapter_ == address(0) || l2ExchangeRecipient_ == address(0)) {
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

        _bridgeAdapter = bridgeAdapter_;
        _l2ExchangeRecipient = l2ExchangeRecipient_;
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
    function bridgeAdapter() external view override returns (address) {
        return _bridgeAdapter;
    }

    /// @inheritdoc IL1DefiVault
    function l2ExchangeRecipient() external view override returns (address) {
        return _l2ExchangeRecipient;
    }

    /// @inheritdoc IL1DefiVault
    function paused() external view override returns (bool) {
        return _paused;
    }

    /// @dev Accept native ETH refunds from bridge adapter flows (e.g. excess gas refunded by zkSync).
    receive() external payable {}

    /// @inheritdoc IL1DefiVault
    function setBridgeAdapter(address adapter) external override onlyVaultAdmin {
        if (adapter == address(0)) revert InvalidParam();
        address previous = _bridgeAdapter;
        _bridgeAdapter = adapter;
        emit BridgeAdapterUpdated(previous, adapter);
    }

    /// @inheritdoc IL1DefiVault
    function setL2ExchangeRecipient(address l2Recipient) external override onlyVaultAdmin {
        if (l2Recipient == address(0)) revert InvalidParam();
        address previous = _l2ExchangeRecipient;
        _l2ExchangeRecipient = l2Recipient;
        emit L2ExchangeRecipientUpdated(previous, l2Recipient);
    }

    /// @inheritdoc IL1DefiVault
    function sweepNative(address payable to, uint256 amount) external override onlyVaultAdmin nonReentrant {
        if (to == address(0) || amount == 0 || amount > address(this).balance) revert InvalidParam();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeSwept(to, amount);
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
        return _tokenConfigs[token];
    }

    /// @inheritdoc IL1DefiVault
    function setTokenConfig(address token, TokenConfig calldata cfg) external override onlyVaultAdmin {
        if (token == address(0)) revert InvalidParam();
        _tokenConfigs[token] = cfg;
        emit TokenConfigUpdated(token, cfg);
    }

    /// @inheritdoc IL1DefiVault
    function isStrategyWhitelisted(address token, address strategy) external view override returns (bool) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return _strategyConfigs[token][strategy].whitelisted;
    }

    /// @inheritdoc IL1DefiVault
    function getStrategyConfig(address token, address strategy) external view override returns (StrategyConfig memory) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return _strategyConfigs[token][strategy];
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Handles four cases based on `cfg.whitelisted` and whether the strategy is already active:
     *
     *      Case 1 — Whitelist a new strategy (`cfg.whitelisted == true`, not yet active):
     *        Adds strategy to `_tokenStrategies`, writes config. Requires token to be supported.
     *
     *      Case 2 — Update a live whitelisted strategy (`cfg.whitelisted == true`, already active):
     *        Overwrites config in place (e.g. to change cap or tag). No list modification.
     *
     *      Case 3 — De-list a strategy with no active position (`cfg.whitelisted == false`, not active):
     *        Clears config and emits removal event. No list modification needed.
     *
     *      Case 4 — De-list a strategy with an active position (`cfg.whitelisted == false`, active):
     *        (a) Writes config immediately so new allocations are blocked (withdraw-only mode).
     *        (b) Probes `strategy.assets(token)`. If zero, removes from list and clears config.
     *            If non-zero, leaves in withdraw-only mode; caller must deallocate first and call
     *            again to complete removal. If the probe reverts, emits `StrategyRemovalCheckFailed`
     *            and leaves the strategy in withdraw-only mode.
     */
    function whitelistStrategy(
        address token,
        address strategy,
        StrategyConfig calldata cfg
    ) external override onlyVaultAdmin {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        if (cfg.whitelisted && !_tokenConfigs[token].supported) revert TokenNotSupported();

        bool exists = _isActiveStrategy(token, strategy);
        if (cfg.whitelisted) {
            if (!exists) _addStrategy(token, strategy);
            _strategyConfigs[token][strategy] = cfg;
            emit StrategyWhitelistUpdated(token, strategy, true, cfg.cap, cfg.tag);
            return;
        }

        if (!exists) {
            delete _strategyConfigs[token][strategy];
            emit StrategyWhitelistUpdated(token, strategy, false, 0, bytes32(0));
            return;
        }

        // Switch to withdraw-only mode immediately.
        _strategyConfigs[token][strategy] = cfg;

        bool canRemove;
        try IYieldStrategy(strategy).assets(token) returns (uint256 assets_) {
            canRemove = assets_ == 0;
        } catch {
            emit StrategyRemovalCheckFailed(token, strategy);
        }
        if (canRemove) {
            _removeStrategy(token, strategy);
            delete _strategyConfigs[token][strategy];
            emit StrategyWhitelistUpdated(token, strategy, false, 0, bytes32(0));
            return;
        }

        emit StrategyWhitelistUpdated(token, strategy, false, cfg.cap, cfg.tag);
    }

    /// @inheritdoc IL1DefiVault
    function idleAssets(address token) public view override returns (uint256) {
        if (token == address(0)) revert InvalidParam();
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Returns 0 if the strategy is neither whitelisted nor in withdraw-only mode (i.e. not active).
     *      Delegates to `IYieldStrategy.assets(token)` without `try/catch`; reverts propagate to caller.
     */
    function strategyAssets(address token, address strategy) public view override returns (uint256) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        if (!_canWithdrawFromStrategy(token, strategy)) return 0;
        return IYieldStrategy(strategy).assets(token);
    }

    /// @inheritdoc IL1DefiVault
    function totalAssets(address token) public view override returns (uint256 total) {
        (total, ) = _totalAssetsStatus(token);
    }

    /// @inheritdoc IL1DefiVault
    function totalAssetsStatus(
        address token
    ) external view override returns (uint256 total, uint256 skippedStrategies) {
        return _totalAssetsStatus(token);
    }

    /**
     * @notice Internal implementation of `totalAssets` / `totalAssetsStatus`.
     * @dev Sums idle balance plus each active strategy's `assets(token)` return value.
     *      Strategy calls are wrapped in `try/catch`; failures increment `skippedStrategies`
     *      without reverting. Callers should treat non-zero `skippedStrategies` as a signal
     *      that the reported total is a lower bound on actual vault TVL.
     * @param token The ERC20 token address to sum across.
     * @return total            Sum of idle balance and all successfully queried strategy balances.
     * @return skippedStrategies Number of strategies whose `assets()` call reverted.
     */
    function _totalAssetsStatus(address token) internal view returns (uint256 total, uint256 skippedStrategies) {
        if (token == address(0)) revert InvalidParam();

        total = IERC20(token).balanceOf(address(this));
        address[] storage list = _tokenStrategies[token];
        for (uint256 i = 0; i < list.length; ++i) {
            try IYieldStrategy(list[i]).assets(token) returns (uint256 assets_) {
                total += assets_;
            } catch {
                unchecked {
                    ++skippedStrategies;
                }
            }
        }
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Returns 0 if the token is not supported. Otherwise returns `idle - idleReserve`,
     *      clamped to zero (i.e. returns 0 when idle ≤ idleReserve). The `idleReserve` floor
     *      is enforced both here and inside `allocateToStrategy` and `_rebalanceToL2`.
     */
    function availableForRebalance(address token) public view override returns (uint256) {
        if (token == address(0)) revert InvalidParam();

        TokenConfig memory cfg = _tokenConfigs[token];
        if (!cfg.supported) return 0;

        uint256 idle = idleAssets(token);
        if (idle <= cfg.idleReserve) return 0;
        unchecked {
            return idle - cfg.idleReserve;
        }
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Enforces in order:
     *      1. Token is supported (`TokenConfig.supported == true`).
     *      2. Strategy is whitelisted (`StrategyConfig.whitelisted == true`).
     *      3. Post-allocation idle balance does not fall below `idleReserve`
     *         (`idle - amount >= idleReserve`).
     *      4. If `StrategyConfig.cap != 0`, the strategy's existing position plus `amount`
     *         must not exceed the cap. The cap check calls `strategy.assets(token)` directly
     *         and will revert if that call fails.
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
        uint256 amount,
        bytes calldata data
    ) external override nonReentrant whenNotPaused onlyAllocator {
        if (token == address(0) || strategy == address(0) || amount == 0) revert InvalidParam();

        TokenConfig memory cfg = _tokenConfigs[token];
        if (!cfg.supported) revert TokenNotSupported();
        StrategyConfig memory sCfg = _strategyConfigs[token][strategy];
        if (!sCfg.whitelisted) revert StrategyNotWhitelisted();

        uint256 idle = idleAssets(token);
        if (idle < amount || idle - amount < cfg.idleReserve) revert InvalidParam();

        if (sCfg.cap != 0) {
            uint256 current = IYieldStrategy(strategy).assets(token);
            if (current + amount > sCfg.cap) revert CapExceeded();
        }

        IERC20(token).forceApprove(strategy, amount);
        IYieldStrategy(strategy).allocate(token, amount, data);
        IERC20(token).forceApprove(strategy, 0);

        emit Allocate(token, strategy, amount, data);
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
     *      impossible for a correct strategy, but guards against malicious adapters).
     */
    function deallocateFromStrategy(
        address token,
        address strategy,
        uint256 amount,
        bytes calldata data
    ) external override nonReentrant onlyAllocatorOrAdmin returns (uint256 received) {
        if (token == address(0) || strategy == address(0) || amount == 0) revert InvalidParam();
        if (!_canWithdrawFromStrategy(token, strategy)) revert StrategyNotWhitelisted();

        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        uint256 reported = IYieldStrategy(strategy).deallocate(token, amount, data);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert InvalidParam();
        received = afterBal - beforeBal;

        if (reported != received) emit StrategyReportedReceivedMismatch(token, strategy, amount, reported, received);
        emit Deallocate(token, strategy, amount, received, data);
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
        address strategy,
        bytes calldata data
    ) external override nonReentrant onlyAllocatorOrAdmin returns (uint256 received) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        if (!_canWithdrawFromStrategy(token, strategy)) revert StrategyNotWhitelisted();

        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        uint256 reported = IYieldStrategy(strategy).deallocateAll(token, data);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) revert InvalidParam();
        received = afterBal - beforeBal;

        if (reported != received) {
            emit StrategyReportedReceivedMismatch(token, strategy, type(uint256).max, reported, received);
        }
        emit Deallocate(token, strategy, type(uint256).max, received, data);
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Enforces standard rebalance policy via `_rebalanceToL2` (rate limits, per-tx cap,
     *      `availableForRebalance` check). Blocked when vault is paused.
     *
     *      ETH bridge fee: caller must supply exact bridge fee as `msg.value`. The full value
     *      is forwarded to `IExchangeBridgeAdapter.sendToL2`; no portion is retained by the vault.
     */
    function rebalanceToL2(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable override nonReentrant whenNotPaused onlyRebalancer {
        bytes32 txHash = _rebalanceToL2(
            token,
            amount,
            l2TxGasLimit,
            l2TxGasPerPubdataByte,
            refundRecipient,
            msg.value,
            true
        );
        emit RebalanceToL2(token, amount, l2TxGasLimit, l2TxGasPerPubdataByte, refundRecipient, txHash);
    }

    /**
     * @inheritdoc IL1DefiVault
     * @dev Bypass mode: skips pause check, `availableForRebalance` / `idleReserve` floor,
     *      per-tx cap (`rebalanceMaxPerTx`), and rate-limit delay (`rebalanceMinDelay`).
     *      Token must still be configured with a non-zero `_bridgeAdapter` and `_l2ExchangeRecipient`.
     *
     *      Auto-unwind: if the vault's idle balance is less than `amount`, the function iterates
     *      `_tokenStrategies[token]` and pulls funds from each strategy via best-effort
     *      `try/catch` deallocate calls until the shortfall is covered or all strategies are
     *      exhausted. Strategies that revert or return a decreased balance are skipped with an
     *      `EmergencyStrategySkipped` event. If the balance is still insufficient after the full
     *      iteration, the call reverts.
     *
     *      ETH bridge fee: same forwarding model as `rebalanceToL2`.
     */
    function emergencySendToL2(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable override nonReentrant onlyRebalancerOrAdmin {
        if (token == address(0) || amount == 0) revert InvalidParam();
        if (_bridgeAdapter == address(0) || _l2ExchangeRecipient == address(0)) revert InvalidParam();
        if (l2TxGasLimit == 0 || l2TxGasPerPubdataByte == 0 || refundRecipient == address(0)) revert InvalidParam();

        IERC20 asset = IERC20(token);
        uint256 idle = asset.balanceOf(address(this));
        if (idle < amount) {
            _unwindStrategiesForEmergency(asset, token, amount - idle);
        }

        if (asset.balanceOf(address(this)) < amount) revert InvalidParam();

        asset.forceApprove(_bridgeAdapter, amount);
        bytes32 txHash = IExchangeBridgeAdapter(_bridgeAdapter).sendToL2{value: msg.value}(
            token,
            amount,
            _l2ExchangeRecipient,
            l2TxGasLimit,
            l2TxGasPerPubdataByte,
            refundRecipient
        );
        asset.forceApprove(_bridgeAdapter, 0);
        emit EmergencyToL2(token, amount, l2TxGasLimit, l2TxGasPerPubdataByte, refundRecipient, txHash);
    }

    /**
     * @notice Returns the current active strategy list for a token.
     * @dev Includes withdraw-only strategies that still hold a position (pending full removal).
     *      The array length is bounded by `MAX_STRATEGIES_PER_TOKEN`.
     * @param token The ERC20 token address.
     * @return Array of strategy addresses currently tracked for `token`.
     */
    function getTokenStrategies(address token) external view returns (address[] memory) {
        return _tokenStrategies[token];
    }

    /**
     * @notice Returns the block timestamp of the last successful `rebalanceToL2` call for a token.
     * @dev Only updated by the rate-limited `rebalanceToL2` path (`enforceRateLimits == true`).
     *      `emergencySendToL2` does NOT update this value. Returns 0 if no rebalance has occurred.
     * @param token The ERC20 token address.
     * @return Unix timestamp (seconds) of the most recent successful rebalance, or 0.
     */
    function lastRebalanceAt(address token) external view returns (uint64) {
        return _lastRebalanceAt[token];
    }

    /**
     * @notice Shared internal logic for L1 → L2 bridge sends.
     * @dev Validates all parameters, optionally enforces rate-limit policy, then calls the bridge adapter.
     *
     *      Policy enforced when `enforceRateLimits == true` (normal `rebalanceToL2` path):
     *        - `amount <= cfg.rebalanceMaxPerTx` (if non-zero)
     *        - `amount <= availableForRebalance(token)` (respects `idleReserve`)
     *        - cooldown: `block.timestamp >= lastRebalanceAt + rebalanceMinDelay` (if both non-zero)
     *        - Updates `_lastRebalanceAt[token]` and emits `RebalanceTimestampUpdated`.
     *
     *      When `enforceRateLimits == false` (`emergencySendToL2` path), all policy checks above
     *      are skipped; only zero-value guards and non-zero config checks are performed.
     *
     *      Approval pattern: grants exact `amount` allowance to the bridge adapter, calls
     *      `sendToL2`, then resets allowance to 0.
     *
     * @param token                  ERC20 token to bridge.
     * @param amount                 Amount of `token` to send.
     * @param l2TxGasLimit           Gas limit for the L2 execution leg.
     * @param l2TxGasPerPubdataByte  Gas price per pubdata byte for the L2 transaction.
     * @param refundRecipient        Address to receive any surplus bridge fee on L2.
     * @param feeValue               ETH value to forward to the adapter as the bridge fee.
     * @param enforceRateLimits      If true, applies per-token rate-limit and cap policy.
     * @return txHash                Bridge transaction hash returned by the adapter.
     */
    function _rebalanceToL2(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient,
        uint256 feeValue,
        bool enforceRateLimits
    ) internal returns (bytes32 txHash) {
        if (token == address(0) || amount == 0) revert InvalidParam();
        TokenConfig memory cfg = _tokenConfigs[token];
        if (!cfg.supported) revert TokenNotSupported();
        if (_bridgeAdapter == address(0) || _l2ExchangeRecipient == address(0)) revert InvalidParam();
        if (l2TxGasLimit == 0 || l2TxGasPerPubdataByte == 0 || refundRecipient == address(0)) revert InvalidParam();

        if (cfg.rebalanceMaxPerTx != 0 && amount > cfg.rebalanceMaxPerTx) revert CapExceeded();
        if (amount > availableForRebalance(token)) revert InvalidParam();
        if (enforceRateLimits) {
            uint64 previousTs = _lastRebalanceAt[token];
            if (
                cfg.rebalanceMinDelay != 0 &&
                previousTs != 0 &&
                block.timestamp < uint256(previousTs) + uint256(cfg.rebalanceMinDelay)
            ) revert RateLimited();

            uint64 newTs = uint64(block.timestamp);
            _lastRebalanceAt[token] = newTs;
            emit RebalanceTimestampUpdated(token, previousTs, newTs, cfg.rebalanceMinDelay);
        }

        IERC20(token).forceApprove(_bridgeAdapter, amount);
        txHash = IExchangeBridgeAdapter(_bridgeAdapter).sendToL2{value: feeValue}(
            token,
            amount,
            _l2ExchangeRecipient,
            l2TxGasLimit,
            l2TxGasPerPubdataByte,
            refundRecipient
        );
        IERC20(token).forceApprove(_bridgeAdapter, 0);
    }

    /**
     * @notice Returns true if `strategy` is present in the active strategy list for `token`.
     * @dev O(1) lookup via the reverse-index map. A non-zero `indexPlusOne` entry means the
     *      strategy is in `_tokenStrategies`, regardless of its `whitelisted` flag.
     */
    function _isActiveStrategy(address token, address strategy) internal view returns (bool) {
        return _strategyIndexPlusOne[token][strategy] != 0;
    }

    /**
     * @notice Returns true if funds may be withdrawn from `strategy` for `token`.
     * @dev Withdrawal is permitted when the strategy is either:
     *      - Whitelisted (`StrategyConfig.whitelisted == true`), OR
     *      - Active (present in `_tokenStrategies`) — i.e. in withdraw-only mode.
     *
     *      This allows deallocation from strategies that have been de-whitelisted but still
     *      hold a position, without requiring a separate flag or state transition.
     */
    function _canWithdrawFromStrategy(address token, address strategy) internal view returns (bool) {
        return _strategyConfigs[token][strategy].whitelisted || _isActiveStrategy(token, strategy);
    }

    /**
     * @notice Iterates active strategies for `token` and deallocates up to `needed` units.
     * @dev Used exclusively by `emergencySendToL2` to top up idle balance before bridging.
     *
     *      For each strategy (bounded by `MAX_STRATEGIES_PER_TOKEN`):
     *        1. Probes `strategy.assets(token)` via `try/catch`. Skips on failure.
     *        2. Requests `min(needed, sAssets)` from the strategy via `_tryEmergencyDeallocate`.
     *        3. Subtracts the measured received amount from `needed`.
     *        4. Stops early when `needed` reaches 0.
     *
     *      Each failed strategy emits `EmergencyStrategySkipped` and is non-fatal. The caller
     *      is responsible for checking that the final idle balance meets the target.
     *
     * @param asset  IERC20 instance (to avoid repeated casting).
     * @param token  Token address (used for strategy calls and event emission).
     * @param needed Shortfall to cover; units in token's decimals.
     */
    function _unwindStrategiesForEmergency(IERC20 asset, address token, uint256 needed) internal {
        address[] storage list = _tokenStrategies[token];
        for (uint256 i = 0; i < list.length && needed > 0; ++i) {
            address strategy = list[i];

            uint256 sAssets;
            try IYieldStrategy(strategy).assets(token) returns (uint256 assets_) {
                sAssets = assets_;
            } catch {
                emit EmergencyStrategySkipped(token, strategy);
                continue;
            }
            if (sAssets == 0) continue;

            uint256 request = needed < sAssets ? needed : sAssets;
            (uint256 got, bool ok) = _tryEmergencyDeallocate(asset, token, strategy, request);
            if (!ok) {
                emit EmergencyStrategySkipped(token, strategy);
                continue;
            }

            if (got >= needed) {
                needed = 0;
            } else {
                unchecked {
                    needed -= got;
                }
            }
            emit Deallocate(token, strategy, request, got, "");
        }
    }

    /**
     * @notice Best-effort single-strategy deallocation for emergency unwinds.
     * @dev Calls `strategy.deallocate(token, request, "")` inside a `try/catch`.
     *      Returns `(0, false)` on any of:
     *        - `deallocate` reverts.
     *        - The vault's token balance decreases after the call (should be impossible for
     *          a correct strategy, but guards against malicious implementations).
     *
     *      On success, the measured balance delta is used as `got`, not the strategy-reported
     *      return value. A mismatch triggers `StrategyReportedReceivedMismatch`.
     *
     * @param asset    IERC20 instance for balance checks.
     * @param token    Token address passed to `deallocate`.
     * @param strategy Strategy to call.
     * @param request  Amount to request from the strategy.
     * @return got     Actual token amount received by the vault (balance delta).
     * @return ok      True if the call succeeded and the balance did not decrease.
     */
    function _tryEmergencyDeallocate(
        IERC20 asset,
        address token,
        address strategy,
        uint256 request
    ) internal returns (uint256 got, bool ok) {
        uint256 beforeBal = asset.balanceOf(address(this));
        uint256 reported;
        try IYieldStrategy(strategy).deallocate(token, request, "") returns (uint256 received_) {
            reported = received_;
        } catch {
            return (0, false);
        }
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) return (0, false);
        got = afterBal - beforeBal;
        if (reported != got) emit StrategyReportedReceivedMismatch(token, strategy, request, reported, got);
        return (got, true);
    }

    /**
     * @notice Appends `strategy` to the active strategy list for `token` and updates the reverse index.
     * @dev Reverts with `CapExceeded` if `_tokenStrategies[token].length == MAX_STRATEGIES_PER_TOKEN`.
     *      After the push, `_strategyIndexPlusOne` is set to `list.length` (i.e. the new last index + 1).
     */
    function _addStrategy(address token, address strategy) internal {
        address[] storage list = _tokenStrategies[token];
        if (list.length >= MAX_STRATEGIES_PER_TOKEN) revert CapExceeded();
        list.push(strategy);
        _strategyIndexPlusOne[token][strategy] = list.length;
    }

    /**
     * @notice Removes `strategy` from the active strategy list for `token` using swap-pop.
     * @dev No-op if `strategy` is not present (index == 0).
     *
     *      Swap-pop algorithm (O(1)):
     *        1. Look up `strategy`'s index via `_strategyIndexPlusOne`.
     *        2. If not the last element, overwrite its slot with the last element and update
     *           the displaced element's reverse index entry.
     *        3. Pop the last element and delete `strategy`'s reverse index entry.
     *
     *      Order of elements in `_tokenStrategies` is not preserved, which is acceptable
     *      because all consumers treat it as an unordered set.
     */
    function _removeStrategy(address token, address strategy) internal {
        uint256 indexPlusOne = _strategyIndexPlusOne[token][strategy];
        if (indexPlusOne == 0) return;

        address[] storage list = _tokenStrategies[token];
        uint256 removeIndex = indexPlusOne - 1;
        uint256 lastIndex = list.length - 1;

        if (removeIndex != lastIndex) {
            address last = list[lastIndex];
            list[removeIndex] = last;
            _strategyIndexPlusOne[token][last] = indexPlusOne;
        }

        list.pop();
        delete _strategyIndexPlusOne[token][strategy];
    }
}
