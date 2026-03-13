// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PositionComponent, ConservativeTokenTotals, TokenTotals} from "./IVaultReportingTypes.sol";

/**
 * @title IL1TreasuryVault
 * @notice L1 treasury vault interface for custody, strategy allocation, and L1->L2 bridging.
 * @dev All vault and strategy accounting flows use ERC20 token addresses directly.
 */
interface IL1TreasuryVault {
    // --------- Errors ---------
    /// @dev Caller does not hold required role.
    error Unauthorized();
    /// @dev Operation is blocked while vault is paused.
    error Paused();
    /// @dev Vault token is not enabled for normal operations.
    error TokenNotSupported();
    /// @dev Strategy is not authorized for the requested vault token.
    error StrategyNotWhitelisted();
    /// @dev Generic invalid input/config guard.
    error InvalidParam();
    /// @dev Operation exceeds configured cap.
    error CapExceeded();
    /// @dev Native ETH payout/transfer failed.
    error NativeTransferFailed();
    /// @dev Strategy token read failed or returned malformed data.
    error InvalidStrategyTokenRead(address token, address strategy);
    /// @dev Strategy exposure read failed.
    error InvalidStrategyExposureRead(address token, address strategy);
    /// @dev Allocation-side vault balance delta was invalid or inconsistent with the request.
    error InvalidAllocationBalanceDelta(
        address token,
        address strategy,
        uint256 requested,
        uint256 beforeBal,
        uint256 afterBal
    );
    /// @dev Harvest output is lower than required `minReceived`.
    error SlippageExceeded();
    /// @dev Requested harvest exceeds currently harvestable amount.
    error YieldNotAvailable();
    /// @dev Yield-recipient timelock controller is not configured.
    error YieldRecipientTimelockControllerNotSet();
    /// @dev Native bridge gateway is not configured.
    error NativeBridgeGatewayNotSet();

    // --------- Roles (RBAC) ---------
    /// @notice Role allowed to configure vault policy and privileged controls.
    function VAULT_ADMIN_ROLE() external view returns (bytes32);

    /// @notice Role allowed to execute normal L1 -> L2 rebalance operations.
    function REBALANCER_ROLE() external view returns (bytes32);

    /// @notice Role allowed to allocate/deallocate strategy positions.
    function ALLOCATOR_ROLE() external view returns (bytes32);

    /// @notice Role allowed to pause allocations, harvests, and normal L1 -> L2 rebalances.
    function PAUSER_ROLE() external view returns (bytes32);

    /// @notice Returns whether `account` currently holds `role`.
    function hasRole(bytes32 role, address account) external view returns (bool);

    // --------- Core config ---------
    /// @notice BridgeHub contract used to submit L1 -> L2 bridge requests.
    function bridgeHub() external view returns (address);

    /// @notice GRVT bridge-proxy fee token contract used to fund bridge `mintValue`.
    function grvtBridgeProxyFeeToken() external view returns (address);

    /// @notice Target L2 chain id for all bridge submissions.
    function l2ChainId() external view returns (uint256);

    /// @notice L2 recipient that receives bridged funds.
    function l2ExchangeRecipient() external view returns (address);

    /// @notice Wrapped native token used whenever the vault represents native ETH as an ERC20 balance.
    function wrappedNativeToken() external view returns (address);

    /// @notice Native bridge gateway used for L1 -> L2 native bridge sends and failed-deposit recovery.
    function nativeBridgeGateway() external view returns (address);

    /// @notice Recipient that receives harvested yield and native sweep funds.
    function yieldRecipient() external view returns (address);

    /// @notice Timelock controller authorized to update yield recipient.
    function yieldRecipientTimelockController() external view returns (address);

    /// @notice Returns true when vault is paused.
    function paused() external view returns (bool);

    /// @notice Enters paused mode for normal fund-moving operations.
    /// @dev Implementations should restrict this call to pauser/admin authority.
    function pause() external;

    /// @notice Exits paused mode.
    /// @dev Implementations should restrict this call to vault-admin authority.
    function unpause() external;

    /// @notice Sets one-time timelock authority for yield-recipient updates.
    /// @param newTimelock Timelock controller address.
    function setYieldRecipientTimelockController(address newTimelock) external;

    /// @notice Updates configured yield recipient via timelock governance.
    /// @param newYieldRecipient New recipient address.
    function setYieldRecipient(address newYieldRecipient) external;

    /// @notice Updates the native bridge gateway used for outbound native bridge sends.
    /// @param newNativeBridgeGateway New native bridge gateway address.
    function setNativeBridgeGateway(address newNativeBridgeGateway) external;

    // --------- Token support & risk controls ---------
    /// @notice Whether a vault token is enabled for normal operations.
    struct VaultTokenConfig {
        /// @dev True if the token can be used for normal allocate and rebalance calls.
        bool supported;
    }

    /// @notice Returns support config for `vaultToken`.
    function getVaultTokenConfig(address vaultToken) external view returns (VaultTokenConfig memory);

    /// @notice Sets support config for `vaultToken`.
    /// @dev Implementations should validate token address and enforce admin-only access.
    function setVaultTokenConfig(address vaultToken, VaultTokenConfig calldata cfg) external;

    /// @notice Returns the vault tokens currently enabled for normal operations.
    function getSupportedVaultTokens() external view returns (address[] memory);

    /// @notice Returns whether `vaultToken` is currently supported for normal operations.
    function isSupportedVaultToken(address vaultToken) external view returns (bool);

    // --------- Strategy registry (whitelist) ---------
    /// @notice Settings for one `(vaultToken, strategy)` pair.
    struct VaultTokenStrategyConfig {
        /// @dev True allows new allocations.
        bool whitelisted;
        /// @dev True keeps the strategy in the withdraw and reporting list.
        bool active;
        /// @dev Allocation cap for this pair. `0` means uncapped.
        uint256 cap;
    }

    /// @notice Returns whether strategy is currently allocatable for `vaultToken`.
    function isStrategyWhitelistedForVaultToken(address vaultToken, address strategy) external view returns (bool);

    /// @notice Returns full strategy config for one `(vaultToken, strategy)` pair.
    function getVaultTokenStrategyConfig(
        address vaultToken,
        address strategy
    ) external view returns (VaultTokenStrategyConfig memory);

    /// @notice Returns the strategies currently tracked for `vaultToken`.
    /// @dev This can include strategies that no longer accept new allocations but still hold funds.
    function getVaultTokenStrategies(address vaultToken) external view returns (address[] memory);

    /// @notice Sets whitelist and cap settings for one `(vaultToken, strategy)` pair.
    /// @dev Implementations may update lifecycle fields such as `active` internally.
    function setVaultTokenStrategyConfig(
        address vaultToken,
        address strategy,
        VaultTokenStrategyConfig calldata cfg
    ) external;

    // --------- Accounting / views ---------
    /// @notice Returns idle balance held directly by vault for `token`.
    function idleTokenBalance(address token) external view returns (uint256);

    /// @notice Returns the tokens and amounts that `strategy` reports for `vaultToken`.
    /// @dev Each amount stays in that token's own units. The vault does not convert between tokens.
    function strategyPositionBreakdown(
        address vaultToken,
        address strategy
    ) external view returns (PositionComponent[] memory);

    /// @notice Returns vault-held balance, strategy-held balance, and total balance for `queryToken`.
    /// @dev Reverts if a strategy read fails.
    function tokenTotals(address queryToken) external view returns (TokenTotals memory);

    /// @notice Returns the same balances as `tokenTotals`, but skips failed strategy reads and reports how many were skipped.
    function tokenTotalsConservative(address queryToken) external view returns (ConservativeTokenTotals memory);

    /// @notice Returns the tokens currently included in TVL reporting.
    /// @dev Reads stored state only and should not call strategies.
    function getTrackedTvlTokens() external view returns (address[] memory);

    /// @notice Returns whether `token` is currently included in TVL reporting.
    function isTrackedTvlToken(address token) external view returns (bool);

    /// @notice Batch version of `tokenTotalsConservative`.
    /// @dev Output ordering is stable: `statuses[i]` corresponds to `queryTokens[i]`.
    function tokenTotalsBatch(address[] calldata queryTokens) external view returns (ConservativeTokenTotals[] memory);

    /// @notice Returns the current TVL token list and balances in one call.
    /// @dev `tokens[i]` aligns with `statuses[i]`.
    function trackedTvlTokenTotals()
        external
        view
        returns (address[] memory tokens, ConservativeTokenTotals[] memory statuses);

    /// @notice Returns how much native ETH can be bridged immediately without withdrawing from strategies.
    /// @dev Measured from idle wrapped-native balance.
    function availableNativeForRebalance() external view returns (uint256);

    /// @notice Returns how much ERC20 can be bridged immediately without withdrawing from strategies.
    function availableErc20ForRebalance(address erc20Token) external view returns (uint256);

    // --------- Yield operations (via whitelisted strategies) ---------
    /// @notice Emitted when the vault allocates a vault token to a strategy.
    /// @param vaultToken Vault token used for the strategy position.
    /// @param strategy Strategy receiving allocation.
    /// @param amount Requested allocation amount.
    event VaultTokenAllocatedToStrategy(address indexed vaultToken, address indexed strategy, uint256 amount);

    /// @notice Emitted when requested allocation amount differs from actual vault-side spend.
    /// @param vaultToken Vault token used for the strategy position.
    /// @param strategy Strategy receiving allocation.
    /// @param requested Requested allocation amount.
    /// @param actualSpent Net vault-side token balance decrease during the allocation call.
    event VaultTokenAllocationSpentMismatch(
        address indexed vaultToken,
        address indexed strategy,
        uint256 requested,
        uint256 actualSpent
    );

    /// @notice Emitted when the vault pulls a vault token back from a strategy.
    /// @param vaultToken Vault token used for the strategy position.
    /// @param strategy Strategy source.
    /// @param requested Requested withdrawal amount (or implementation max marker).
    /// @param received Actual measured amount received by vault.
    event VaultTokenDeallocatedFromStrategy(
        address indexed vaultToken,
        address indexed strategy,
        uint256 requested,
        uint256 received
    );

    /// @notice Emitted when the strategy-reported amount differs from the vault's measured balance change.
    event StrategyReportedReceivedMismatch(
        address indexed vaultToken,
        address indexed strategy,
        uint256 requested,
        uint256 reported,
        uint256 actual
    );

    /// @notice Emitted when admin TVL token override settings change.
    event TrackedTvlTokenOverrideUpdated(address indexed token, bool enabled, bool forceTrack);

    /// @notice Emitted when harvested yield is paid to the yield recipient.
    event YieldHarvested(
        address indexed vaultToken,
        address indexed strategy,
        address indexed yieldRecipient,
        uint256 requested,
        uint256 received
    );

    /// @notice Emitted when yield-recipient timelock controller is configured.
    event YieldRecipientTimelockControllerUpdated(address indexed previousTimelock, address indexed newTimelock);

    /// @notice Emitted when yield recipient is updated via timelock.
    event YieldRecipientUpdated(address indexed previousYieldRecipient, address indexed newYieldRecipient);

    /// @notice Emitted when forced/native-dust ETH is swept to yield recipient.
    event NativeSweptToYieldRecipient(address indexed yieldRecipient, uint256 amount);

    /// @notice Emitted when the configured native bridge gateway changes.
    event NativeBridgeGatewayUpdated(
        address indexed previousNativeBridgeGateway,
        address indexed newNativeBridgeGateway
    );

    /// @notice Allocates vault idle vault-token balance into an approved strategy.
    /// @dev Cost basis increases by measured vault-side net token balance decrease, not by strategy receipt.
    /// @param vaultToken Vault token to allocate.
    /// @param strategy Strategy target.
    /// @param amount Requested allocation amount.
    function allocateVaultTokenToStrategy(address vaultToken, address strategy, uint256 amount) external;

    /// @notice Deallocates vault-token balance from strategy back into vault idle balance.
    /// @param vaultToken Vault token used for the strategy position.
    /// @param strategy Strategy source.
    /// @param amount Requested amount to withdraw.
    /// @return received Actual measured amount received by vault.
    function deallocateVaultTokenFromStrategy(
        address vaultToken,
        address strategy,
        uint256 amount
    ) external returns (uint256 received);

    /// @notice Deallocates all strategy-held vault-token balance for a vault token.
    /// @param vaultToken Vault token used for the strategy position.
    /// @param strategy Strategy source.
    /// @return received Actual measured amount received by vault.
    function deallocateAllVaultTokenFromStrategy(
        address vaultToken,
        address strategy
    ) external returns (uint256 received);

    /// @notice Returns tracked cost basis for one `(vaultToken, strategy)` pair.
    function strategyCostBasis(address vaultToken, address strategy) external view returns (uint256);

    /// @notice Returns currently harvestable yield for one `(vaultToken, strategy)` pair.
    function harvestableYield(address vaultToken, address strategy) external view returns (uint256);

    /// @notice Harvests strategy yield and pays configured yield recipient.
    function harvestYieldFromStrategy(
        address vaultToken,
        address strategy,
        uint256 amount,
        uint256 minReceived
    ) external returns (uint256 received);

    /// @notice Sets the admin TVL token override for one token.
    function setTrackedTvlTokenOverride(address token, bool enabled, bool forceTrack) external;

    /// @notice Refreshes the cached TVL token list for one active `(vaultToken, strategy)` pair.
    function refreshStrategyTvlTokens(address vaultToken, address strategy) external;

    /// @notice Sweeps native ETH balance from vault to yield recipient.
    /// @param amount Native ETH amount to transfer.
    function sweepNativeToYieldRecipient(uint256 amount) external;

    // --------- Rebalancing between L1 vault and L2 exchange ---------
    /// @notice Emitted for all successful L1 -> L2 bridge sends.
    event BridgeSentToL2(
        /// @param token Vault token used for the bridge flow.
        address indexed token,
        /// @param amount Amount bridged.
        uint256 amount,
        /// @param l2TxGasLimit L2 gas limit used for bridge request.
        uint256 l2TxGasLimit,
        /// @param l2TxGasPerPubdataByte L2 pubdata gas setting used for bridge request.
        uint256 l2TxGasPerPubdataByte,
        /// @param refundRecipient Recipient configured for bridge refunds.
        address indexed refundRecipient,
        /// @param bridgeTxHash Returned L2 transaction hash identifier.
        bytes32 bridgeTxHash,
        /// @param isNative True when the bridge path used native intent.
        bool isNative,
        /// @param emergency True when the bridge path used emergency semantics.
        bool emergency
    );

    /// @notice Bridges native ETH to the L2 exchange recipient.
    /// @param amount Native amount to bridge.
    /// @dev Implementations should enforce `msg.value == 0` and fund bridge cost via fee-token minting.
    function rebalanceNativeToL2(uint256 amount) external payable;

    /// @notice Bridges ERC20 token to L2 exchange recipient.
    /// @param erc20Token ERC20 token to bridge (wrapped native should be rejected on this path).
    /// @param amount Token amount to bridge.
    /// @dev Implementations should enforce `msg.value == 0` and fund bridge cost via fee-token minting.
    function rebalanceErc20ToL2(address erc20Token, uint256 amount) external payable;

    // --------- Emergency: force funds back to exchange ---------
    /// @notice Emergency native bridge function for incident response.
    /// @param amount Native amount to bridge.
    /// @dev Emergency flow may bypass normal support/pause policy depending on implementation.
    function emergencyNativeToL2(uint256 amount) external payable;

    /// @notice Emergency ERC20 bridge function for incident response.
    /// @param erc20Token ERC20 token to bridge.
    /// @param amount Token amount to bridge.
    /// @dev Emergency flow may bypass normal support/pause policy depending on implementation.
    function emergencyErc20ToL2(address erc20Token, uint256 amount) external payable;
}
