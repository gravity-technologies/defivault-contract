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

    /// L2 exchange recipient (where top-ups land). (Type may be address for zkSync-like EVM L2s.)
    function l2ExchangeRecipient() external view returns (address);

    /// True => blocks new allocations / non-essential outflows; must still allow "pull back to exchange".
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

    /// Conservative "available now" amount for bridging to L2 without strategy withdraw (default: idle).
    function availableForRebalance(address token) external view returns (uint256);

    // --------- Yield operations (via whitelisted strategies) ---------
    event Allocate(address indexed token, address indexed strategy, uint256 amount, bytes data);
    event Deallocate(address indexed token, address indexed strategy, uint256 requested, uint256 received, bytes data);

    /// Move idle funds into strategy (e.g., supply USDT to Aave -> receive aUSDT).
    function allocateToStrategy(address token, address strategy, uint256 amount, bytes calldata data) external;

    /// Withdraw funds from strategy back to idle (e.g., withdraw USDT from Aave).
    /// Returns actual received (may differ due to protocol mechanics).
    function deallocateFromStrategy(address token, address strategy, uint256 amount, bytes calldata data)
        external
        returns (uint256 received);

    /// Emergency unwind: pull everything possible from a strategy for a token (funds remain in vault idle).
    function deallocateAllFromStrategy(address token, address strategy, bytes calldata data)
        external
        returns (uint256 received);

    // --------- Rebalancing between L1 vault and L2 exchange ---------
    event RebalanceToL2(address indexed token, uint256 amount, bytes bridgeData);
    event RebalanceFromL2(address indexed token, uint256 amount, bytes bridgeData);

    /**
     * Send funds from L1 vault -> L2 exchange (top-up).
     * Must enforce destination = configured L2 exchange recipient and use bridgeAdapter.
     */
    function rebalanceToL2(address token, uint256 amount, bytes calldata bridgeData) external;

    // --------- Emergency: force funds back to exchange ---------
    event EmergencyToL2(address indexed token, uint256 amount, bytes bridgeData);

    /**
     * Pull funds back to the exchange even when paused (pause must NOT block this).
     * Implementation can:
     *  - deallocate from one/more strategies as needed, then
     *  - call rebalanceToL2.
     */
    function emergencySendToL2(address token, uint256 amount, bytes calldata bridgeData) external;
}
