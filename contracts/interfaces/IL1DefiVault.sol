// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * L1 DeFi Vault (Ethereum) that custodies exchange TVL and allocates to yield protocols (Aave first).
 * Key constraints:
 * - Vault may only move funds between itself and the Exchange (via bridge/custody adapter), never arbitrary addresses.
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
    error RateLimited();
    error NativeTransferFailed();
    error UnsafeDestination();

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
    /// L1 adapter that performs the actual bridge/custody interactions for L2 (e.g., zkSync native bridge custody).
    function bridgeAdapter() external view returns (address);

    /// L2 GRVT ZkSync exchange address (where top-ups land)
    function l2ExchangeRecipient() external view returns (address);

    /// True => blocks risk-taking actions (e.g., allocate/rebalance); defensive exits must remain available.
    function paused() external view returns (bool);

    function setBridgeAdapter(address adapter) external;

    function setL2ExchangeRecipient(address l2Recipient) external;

    function pause() external;

    function unpause() external;

    // --------- Token support & risk controls ---------
    struct TokenConfig {
        bool supported;
        uint256 idleReserve; // amount kept liquid on L1 (optional, can be 0)
        uint256 rebalanceMaxPerTx; // optional per-tx max for L1<->L2 rebalances (0 => no limit)
        // Optional (for future consideration)
        uint64 rebalanceMinDelay; // optional min seconds between rebalances per token (0 => no limit)
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory);

    function setTokenConfig(address token, TokenConfig calldata cfg) external;

    // --------- Strategy registry (whitelist) ---------
    struct StrategyConfig {
        bool whitelisted;
        uint256 cap; // optional per-(token, strategy) cap (0 => no cap)
        bytes32 tag; // e.g. "AAVE_V3", "COMPOUND_V3" (optional)
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

    /// Conservative "available now" amount for bridging to L2 without strategy withdraw (default: idle).
    function availableForRebalance(address token) external view returns (uint256);

    // --------- Yield operations (via whitelisted strategies) ---------
    event Allocate(address indexed token, address indexed strategy, uint256 amount, bytes data);
    event Deallocate(address indexed token, address indexed strategy, uint256 requested, uint256 received, bytes data);
    event StrategyReportedReceivedMismatch(
        address indexed token,
        address indexed strategy,
        uint256 requested,
        uint256 reported,
        uint256 actual
    );

    /// Move idle funds into strategy (e.g., supply USDT to Aave -> receive aUSDT).
    function allocateToStrategy(address token, address strategy, uint256 amount, bytes calldata data) external;

    /// Withdraw funds from strategy back to idle (e.g., withdraw USDT from Aave).
    /// Defensive action: callable while paused and when token support is disabled.
    /// Returns actual received (may differ due to protocol mechanics).
    function deallocateFromStrategy(
        address token,
        address strategy,
        uint256 amount,
        bytes calldata data
    ) external returns (uint256 received);

    /// Emergency unwind: pull everything possible from a strategy for a token (funds remain in vault idle).
    /// Defensive action: callable while paused and when token support is disabled.
    function deallocateAllFromStrategy(
        address token,
        address strategy,
        bytes calldata data
    ) external returns (uint256 received);

    // --------- Rebalancing between L1 vault and L2 exchange ---------
    event RebalanceToL2(
        address indexed token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address indexed refundRecipient,
        bytes32 bridgeTxHash
    );
    event RebalanceTimestampUpdated(
        address indexed token,
        uint64 previousTimestamp,
        uint64 newTimestamp,
        uint64 minDelay
    );
    event RebalanceFromL2(address indexed token, uint256 amount, bytes bridgeData);

    /**
     * Send funds from L1 vault -> L2 exchange (top-up) via zkSync-style typed parameters.
     *
     * Fee model:
     * - Caller MUST provide bridge fee ETH as `msg.value`.
     * - Vault forwards full `msg.value` to bridge adapter `sendToL2(...)`.
     * - Implementations should avoid hidden fee buffers to keep accounting explicit.
     */
    function rebalanceToL2(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable;

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
     * Fee model matches rebalanceToL2: caller provides bridge fee via `msg.value`,
     * and vault forwards full value to bridge adapter.
     */
    function emergencySendToL2(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable;

    // --------- Native ETH management ---------
    event NativeSwept(address indexed to, uint256 amount);

    /// Sweep native ETH accidentally retained by vault (e.g., bridge fee refunds).
    function sweepNative(address payable to, uint256 amount) external;
}
