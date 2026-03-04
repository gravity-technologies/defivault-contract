// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {StrategyAssetBreakdown, VaultTokenStatus, VaultTokenTotals} from "./IVaultReportingTypes.sol";

/**
 * @title IL1DefiVault
 * @notice L1 vault interface for custody, strategy allocation, and L1->L2 rebalancing.
 * @dev External write paths use native sentinel semantics; reporting remains canonical ERC20 exact-token.
 *
 * Boundary and reporting model:
 * - Mutating boundary-intent token inputs use `address(0)` for native ETH intent.
 * - Internal accounting and reporting use canonical ERC20 keys (for native: wrapped native token).
 * - Reporting is token-address exact and never converts amounts across token denominations.
 * - Harvest/cap logic uses strategy `principalBearingExposure` scalar, separate from reporting components.
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
    error InvalidStrategyAssetsRead(address token, address strategy);
    error InvalidStrategyExposureRead(address token, address strategy);

    // --------- Roles (RBAC) ---------
    // - VAULT_ADMIN: config, whitelist strategies, and emergency administration
    // - REBALANCER: move funds between L1 vault and L2 exchange
    // - ALLOCATOR: allocate to whitelisted strategies and deallocate from withdrawable strategy entries
    // - PAUSER: pause allocations and risky outflows
    function VAULT_ADMIN_ROLE() external view returns (bytes32);

    function REBALANCER_ROLE() external view returns (bytes32);

    function ALLOCATOR_ROLE() external view returns (bytes32);

    function PAUSER_ROLE() external view returns (bytes32);

    function hasRole(bytes32 role, address account) external view returns (bool);

    // --------- Core config ---------
    /// @notice BridgeHub contract used for L1->L2 bridge request dispatch.
    function bridgeHub() external view returns (address);

    /// @notice Mintable base token used to fund BridgeHub mint value.
    function baseToken() external view returns (address);

    /// @notice Target L2 chain id for bridge requests.
    function l2ChainId() external view returns (uint256);

    /// @notice L2 GRVT ZkSync exchange destination for top-ups.
    /// @return l2Recipient Configured L2 exchange recipient.
    function l2ExchangeRecipient() external view returns (address);

    /// @notice Canonical wrapped native ERC20 key used for internal native exposure accounting.
    /// @return token Wrapped native token address.
    function wrappedNativeToken() external view returns (address);

    /// @notice Whether the vault is paused for non-essential outflows and new allocations.
    /// @return isPaused True when paused.
    function paused() external view returns (bool);

    function pause() external;

    function unpause() external;

    // --------- Token support & risk controls ---------
    struct TokenConfig {
        bool supported;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory);

    function setTokenConfig(address token, TokenConfig calldata cfg) external;

    // --------- Strategy registry (whitelist) ---------
    struct StrategyConfig {
        /// @dev Allocation gate. True means new allocations are allowed for this (token,strategy) pair.
        bool whitelisted;
        /**
         * @dev Membership/lifecycle flag for the token-domain strategy set.
         * True means this strategy is still part of the token's active registry (including withdraw-only mode),
         * so deallocation/reporting/emergency unwind flows may still reference it even when `whitelisted == false`.
         */
        bool active;
        uint256 cap; // optional per-(token, strategy) cap (0 => no cap)
    }

    function isStrategyWhitelisted(address token, address strategy) external view returns (bool);

    function getStrategyConfig(address token, address strategy) external view returns (StrategyConfig memory);

    /// @notice Returns active strategies registered for a token key.
    /// @param token Boundary/canonical token key per vault semantics.
    /// @return strategies Strategy addresses for `token` (whitelisted and withdraw-only active entries).
    function getTokenStrategies(address token) external view returns (address[] memory);

    function whitelistStrategy(address token, address strategy, StrategyConfig calldata cfg) external;

    // --------- Accounting / views ---------
    /// @notice Returns vault idle balance for canonical token key.
    /// @param token Canonical ERC20 token key.
    /// @return amount Idle token balance held by vault.
    function idleAssets(address token) external view returns (uint256);

    /**
     * @notice Returns exact-token strategy reporting for a specific strategy.
     * @param token Canonical ERC20 query key. For native exposure queries, pass wrapped native token.
     * @param strategy Active strategy address.
     * @return breakdown Strategy-reported exact-token component breakdown.
     *
     * @dev Strategy components are exact-token amounts and are never cross-token converted by the vault.
     * Returns an empty breakdown when `strategy` is not globally active.
     * Reverts with `InvalidStrategyAssetsRead(token, strategy)` if strategy read fails.
     */
    function strategyAssets(address token, address strategy) external view returns (StrategyAssetBreakdown memory);

    /**
     * @notice Returns strict exact-token totals for a queried token.
     * @param token Canonical ERC20 query key.
     * @return totals Strict totals struct (`idle`, `strategy`, `total`) for `token`.
     * @dev Returns strict exact-token totals for `token`:
     * - `idle`: idle balance held by vault in `token`
     * - `strategy`: aggregated strategy components where `component.token == token`
     * - `total`: `idle + strategy`
     *
     * Reverts on invalid strategy read/format to preserve strict exact semantics.
     */
    function totalAssets(address token) external view returns (VaultTokenTotals memory);

    /**
     * @notice Returns degraded exact-token totals while skipping invalid strategy reads.
     * @param token Canonical ERC20 query key.
     * @return status Status totals struct with `skippedStrategies` count.
     *
     * @dev `skippedStrategies` reports how many strategies were ignored due to invalid reads.
     * Values are lower-bound and preserve exact-token denomination.
     */
    function totalAssetsStatus(address token) external view returns (VaultTokenStatus memory);

    /// @notice Returns all currently tracked root-domain tokens for raw TVL reporting discovery.
    /// @dev Component/receipt tokens are intentionally excluded from this registry.
    ///      Membership is synchronized on write paths; this read is storage-backed only.
    function getTrackedTokens() external view returns (address[] memory);

    /// @notice Returns whether `token` is currently tracked as a root-domain token.
    /// @dev Component/receipt tokens are not tracked by this root registry.
    function isTrackedToken(address token) external view returns (bool);

    /// @notice Batch status variant of `totalAssetsStatus`.
    /// @param tokens Canonical ERC20 query keys.
    /// @return statuses Exact-token status results aligned to `tokens`.
    /// @dev Output ordering is stable: `statuses[i]` corresponds to `tokens[i]`.
    function totalAssetsBatch(address[] calldata tokens) external view returns (VaultTokenStatus[] memory);

    /// @notice Conservative immediate amount available for L1->L2 bridge without strategy withdrawal.
    /// @param token Canonical ERC20 token key.
    /// @return amount Available token amount.
    function availableForRebalance(address token) external view returns (uint256);

    // --------- Yield operations (via whitelisted strategies) ---------
    /// @notice Emitted when idle vault funds are allocated to a strategy.
    event Allocate(address indexed token, address indexed strategy, uint256 amount);
    /// @notice Emitted when funds are deallocated from a strategy back to idle vault balance.
    event Deallocate(address indexed token, address indexed strategy, uint256 requested, uint256 received);
    event StrategyReportedReceivedMismatch(
        address indexed token,
        address indexed strategy,
        uint256 requested,
        uint256 reported,
        uint256 actual
    );
    /// @notice Emitted when tracked strategy principal is clamped down to post-unwind exposure.
    event StrategyPrincipalWrittenDown(
        address indexed token,
        address indexed strategy,
        uint256 previousPrincipal,
        uint256 newPrincipal,
        uint256 exposureAfter
    );
    /// @notice Emitted when post-unwind principal write-down is skipped due to exposure read failure.
    event StrategyPrincipalWriteDownSkipped(address indexed token, address indexed strategy);
    /// @notice Emitted when forced/native-dust ETH is swept to treasury.
    event NativeSwept(address indexed treasury, uint256 amount);

    /**
     * @notice Moves idle funds into a whitelisted strategy.
     * @param token Boundary-intent token key.
     * @param strategy Whitelisted strategy address.
     * @param amount Amount to allocate.
     *
     * @dev Use `address(0)` for native ETH intent.
     * Passing `wrappedNativeToken()` directly is rejected for mutating boundary-intent APIs.
     */
    function allocateToStrategy(address token, address strategy, uint256 amount) external;

    /**
     * @notice Withdraws funds from strategy back to idle vault balance.
     * @param token Boundary-intent token key.
     * @param strategy Strategy address that is withdrawable for `token`.
     * @param amount Requested deallocation amount.
     * @return received Actual amount received.
     *
     * @dev Use `address(0)` for native ETH intent.
     */
    function deallocateFromStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external returns (uint256 received);

    /// @notice Emergency unwind of full strategy exposure for `token` back into vault idle.
    /// @param token Boundary-intent token key.
    /// @param strategy Strategy address that is withdrawable for `token`.
    /// @return received Actual amount received.
    function deallocateAllFromStrategy(address token, address strategy) external returns (uint256 received);

    /// @notice Recovers forced/native-dust ETH to treasury only.
    /// @param amount Native ETH amount to sweep.
    function sweepNative(uint256 amount) external;

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
     * @notice Sends funds from L1 vault to configured L2 exchange recipient.
     * @param token Boundary-intent token key.
     * @param amount Amount to bridge.
     *
     * @dev Fee model:
     * - `msg.value` must be `0`.
     * - Bridge execution cost is funded via base-token `mintValue` in BridgeHub flow.
     * - Execution params are sourced from vault config, not caller input.
     * - Use `address(0)` to express native ETH bridge intent.
     * - Passing `wrappedNativeToken()` directly is invalid boundary input for this write API.
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
     * @notice Emergency variant of `rebalanceToL2`, callable under incident conditions.
     * @param token Boundary-intent token key.
     * @param amount Amount to bridge.
     *
     * @dev Fee model matches `rebalanceToL2`:
     * - `msg.value` must be `0`.
     * - Bridge execution cost is funded via base-token `mintValue`.
     * Execution params are sourced from vault config.
     * Use `address(0)` to express native ETH bridge intent.
     * Passing `wrappedNativeToken()` directly is invalid boundary input for this write API.
     */
    function emergencySendToL2(address token, uint256 amount) external payable;
}
