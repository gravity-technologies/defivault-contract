// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * L1 DeFi Vault (Ethereum) that custodies exchange TVL and allocates to yield protocols (Aave first).
 * Key constraints:
 * - Vault may only move funds between itself and the Exchange, never arbitrary addresses.
 * - Yield protocol interactions are centralized via whitelisted strategies (strategy pattern).
 * - Emergency controls: pause new allocations / risky operations, but must still allow pulling funds back to Exchange.
 */
interface IL1DefiVault {
    // --------- Errors ---------
    error Unauthorized();
    error Paused();
    error TokenNotSupported();
    error StrategyNotWhitelisted();
    error InvalidParam();
    error CapExceeded();
    error NativeTransferFailed();
    error UnsafeDestination();
    error TreasuryTimelockNotSet();

    /// @dev Thrown when `syncStrategyPrincipal` is called after sync has been permanently locked.
    error PrincipalSyncAlreadyLocked();

    /// @dev Thrown when requested harvest exceeds currently available strategy yield.
    error YieldNotAvailable();

    /// @dev Thrown when actual harvested amount is below caller-provided `minReceived`.
    error SlippageExceeded();

    // --------- Roles (RBAC) ---------
    // - VAULT_ADMIN: config, register/whitelist strategies (Governance)
    // - REBALANCER: move funds between L1 vault and L2 exchange (DefiVaultManagerSvc)
    // - ALLOCATOR: allocate / deallocate to yield strategies (Treasury via DefiVaultManagerSvc)
    // - PAUSER: pause allocations/risky ops
    function VAULT_ADMIN_ROLE() external view returns (bytes32);

    function REBALANCER_ROLE() external view returns (bytes32);

    function ALLOCATOR_ROLE() external view returns (bytes32);

    function PAUSER_ROLE() external view returns (bytes32);

    function hasRole(bytes32 role, address account) external view returns (bool);

    // --------- Core config ---------
    /// L1 BridgeHub contract used to dispatch L1->L2 bridge requests.
    function bridgeHub() external view returns (address);

    /// Mintable base token used to fund BridgeHub mintValue.
    function baseToken() external view returns (address);

    /// Target L2 chain id for BridgeHub requests.
    function l2ChainId() external view returns (uint256);

    /// L2 GRVT ZkSync exchange address (where top-ups land)
    function l2ExchangeRecipient() external view returns (address);

    /// True => blocks risk-taking actions (e.g., allocate/rebalance); defensive exits must remain available.
    function paused() external view returns (bool);

    function pause() external;

    function unpause() external;

    // --------- Treasury management (for harvested yield) ---------
    /// Current treasury recipient for harvested strategy yield.
    function treasury() external view returns (address);

    /// Timelock contract allowed to execute treasury recipient changes.
    function treasuryTimelock() external view returns (address);

    /**
     * @notice Emitted when treasury timelock controller is configured.
     * @param previousTimelock Previous timelock (zero on first set).
     * @param newTimelock New treasury timelock contract.
     */
    event TreasuryTimelockUpdated(address indexed previousTimelock, address indexed newTimelock);

    /**
     * @notice Emitted when treasury recipient is changed.
     * @param previousTreasury Treasury recipient before update.
     * @param newTreasury Treasury recipient after update.
     */
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    /**
     * @notice Sets the timelock contract that governs treasury changes.
     * @dev Callable by `VAULT_ADMIN_ROLE`; intended as one-time bootstrap wiring.
     *      Reverts with `InvalidParam` on zero/non-contract address or if already set.
     * @param newTimelock Timelock controller contract address.
     */
    function setTreasuryTimelock(address newTimelock) external;

    /**
     * @notice Updates treasury recipient for harvested yield.
     * @dev Callable only by configured `treasuryTimelock`.
     *      Reverts with:
     *      - `TreasuryTimelockNotSet` if timelock is not configured.
     *      - `Unauthorized` if caller is not `treasuryTimelock`.
     *      - `InvalidParam` if `newTreasury` is zero, current treasury, or vault address.
     * @param newTreasury Proposed treasury recipient.
     */
    function setTreasury(address newTreasury) external;

    // --------- Token support & risk controls ---------
    struct TokenConfig {
        bool supported;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory);

    function setTokenConfig(address token, TokenConfig calldata cfg) external;

    // --------- Strategy registry (whitelist) ---------
    struct StrategyConfig {
        bool whitelisted;
        // True when strategy is currently tracked in `getTokenStrategies(token)`.
        // Implementations should set this internally and ignore caller-provided values.
        bool active;
        uint256 cap; // optional per-(token, strategy) cap (0 => no cap)
    }

    function isStrategyWhitelisted(address token, address strategy) external view returns (bool);

    function getStrategyConfig(address token, address strategy) external view returns (StrategyConfig memory);

    function whitelistStrategy(address token, address strategy, StrategyConfig calldata cfg) external;

    // --------- Accounting / views ---------
    /// Idle = token.balanceOf(vault)
    function idleAssets(address token) external view returns (uint256);

    /// Assets held inside a specific strategy (reported by strategy).
    function strategyAssets(address token, address strategy) external view returns (uint256);

    /// Total = idle + sum(strategies). Used for TVL accounting and risk checks.
    function totalAssets(address token) external view returns (uint256);

    /// Total with degraded-state visibility if one or more strategies fail `assets(token)` calls.
    function totalAssetsStatus(address token) external view returns (uint256 total, uint256 skippedStrategies);

    /// Returns all tokens currently tracked for raw TVL reporting.
    function getTrackedTokens() external view returns (address[] memory);

    /// Returns whether a token is currently tracked for raw TVL reporting.
    function isTrackedToken(address token) external view returns (bool);

    /// Batch variant of totalAssetsStatus for a caller-provided token list.
    function totalAssetsBatch(
        address[] calldata tokens
    ) external view returns (uint256[] memory totals, uint256[] memory skippedStrategies);

    /// Conservative "available now" amount for bridging to L2 without strategy withdraw (default: idle).
    function availableForRebalance(address token) external view returns (uint256);

    // --------- Yield operations (via whitelisted strategies) ---------
    event Allocate(address indexed token, address indexed strategy, uint256 amount);
    event Deallocate(address indexed token, address indexed strategy, uint256 requested, uint256 received);
    event StrategyReportedReceivedMismatch(
        address indexed token,
        address indexed strategy,
        uint256 requested,
        uint256 reported,
        uint256 actual
    );
    /**
     * @notice Emitted when tracked strategy principal changes.
     * @dev Principal changes on allocate/deallocate flows and explicit sync operations.
     * @param token Underlying token of the strategy position.
     * @param strategy Strategy whose principal changed.
     * @param previousPrincipal Principal value before update.
     * @param newPrincipal Principal value after update.
     */
    event StrategyPrincipalUpdated(
        address indexed token,
        address indexed strategy,
        uint256 previousPrincipal,
        uint256 newPrincipal
    );

    /// @notice Emitted when principal sync is permanently disabled.
    event PrincipalSyncLockActivated();

    /**
     * @notice Emitted when strategy yield is harvested to treasury.
     * @param token Underlying token being harvested.
     * @param strategy Strategy from which yield is withdrawn.
     * @param treasury Treasury recipient that receives harvested funds.
     * @param requested Amount requested from strategy.
     * @param received Actual amount transferred to treasury.
     */
    event YieldHarvested(
        address indexed token,
        address indexed strategy,
        address indexed treasury,
        uint256 requested,
        uint256 received
    );

    /// Move idle funds into strategy (e.g., supply USDT to Aave -> receive aUSDT).
    function allocateToStrategy(address token, address strategy, uint256 amount) external;

    /// Withdraw funds from strategy back to idle (e.g., withdraw USDT from Aave).
    /// Defensive action: callable while paused and when token support is disabled.
    /// Returns actual received (may differ due to protocol mechanics).
    function deallocateFromStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external returns (uint256 received);

    /// Emergency unwind: pull everything possible from a strategy for a token (funds remain in vault idle).
    /// Defensive action: callable while paused and when token support is disabled.
    function deallocateAllFromStrategy(address token, address strategy) external returns (uint256 received);

    /**
     * @notice Returns tracked principal for a strategy position.
     * @dev Principal tracks net capital attributed to strategy and is used to separate
     *      principal from harvestable yield.
     * @param token Underlying token.
     * @param strategy Strategy address.
     * @return Tracked principal amount.
     */
    function strategyPrincipal(address token, address strategy) external view returns (uint256);

    /**
     * @notice Returns currently harvestable yield for a strategy position.
     * @dev Defined as `max(strategyAssets(token, strategy) - strategyPrincipal(token, strategy), 0)`.
     * @param token Underlying token.
     * @param strategy Strategy address.
     * @return Harvestable yield amount.
     */
    function harvestableYield(address token, address strategy) external view returns (uint256);

    /**
     * @notice Withdraws yield from strategy and transfers it to treasury.
     * @dev Callable by `VAULT_ADMIN_ROLE` and blocked while paused.
     *      Reverts with:
     *      - `StrategyNotWhitelisted` if strategy is not withdrawable.
     *      - `YieldNotAvailable` if `amount` exceeds currently harvestable yield.
     *      - `SlippageExceeded` if actual received is below `minReceived`.
     * @param token Underlying token.
     * @param strategy Strategy address.
     * @param amount Requested amount to harvest.
     * @param minReceived Minimum acceptable net amount received by treasury after vault->treasury transfer.
     * @return received Actual net amount received by treasury.
     */
    function harvestYieldFromStrategy(
        address token,
        address strategy,
        uint256 amount,
        uint256 minReceived
    ) external returns (uint256 received);

    /**
     * @notice Sets tracked principal to current strategy assets.
     * @dev Reconciliation safety valve callable by `VAULT_ADMIN_ROLE`.
     *      Reverts with `PrincipalSyncAlreadyLocked` after `lockPrincipalSync`.
     * @param token Underlying token.
     * @param strategy Strategy address.
     */
    function syncStrategyPrincipal(address token, address strategy) external;

    /**
     * @notice Returns whether principal sync is permanently disabled.
     * @return True once `lockPrincipalSync` has been executed.
     */
    function principalSyncLocked() external view returns (bool);

    /**
     * @notice Irreversibly disables future calls to `syncStrategyPrincipal`.
     * @dev Callable by `VAULT_ADMIN_ROLE`.
     *      Implementations should reject repeated calls.
     */
    function lockPrincipalSync() external;

    // --------- Rebalancing between L1 vault and L2 exchange ---------
    event RebalanceToL2(
        address indexed token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address indexed refundRecipient,
        bytes32 bridgeTxHash
    );

    /**
     * Send funds from L1 vault -> L2 exchange (top-up) via zkSync-style typed parameters.
     *
     * Fee model:
     * - Caller MUST provide zero ETH (`msg.value == 0`).
     * - Vault mints base token and submits a BridgeHub two-bridges request.
     * - L2 tx gas limit, gas per pubdata, and refund recipient are sourced from vault config.
     */
    function rebalanceToL2(address token, uint256 amount) external payable;

    // --------- Emergency: force funds back to exchange ---------
    event EmergencyToL2(
        address indexed token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address indexed refundRecipient,
        bytes32 bridgeTxHash
    );

    /**
     * Emergency variant of rebalanceToL2, callable under incident conditions.
     * Defensive action: callable while paused and when token support is disabled.
     *
     * Fee model matches rebalanceToL2: `msg.value` must be zero and base token
     * funding is handled via minting + BridgeHub request. L2 tx gas limit, gas per
     * pubdata, and refund recipient are sourced from vault config.
     */
    function emergencySendToL2(address token, uint256 amount) external payable;

    // --------- Native ETH management ---------
    event NativeSwept(address indexed to, uint256 amount);

    /// Sweep native ETH accidentally retained by vault (e.g., bridge fee refunds).
    function sweepNative(address payable to, uint256 amount) external;

    event TokenTrackingUpdated(address indexed token, bool tracked);
}
