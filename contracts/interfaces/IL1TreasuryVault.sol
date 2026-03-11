// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {StrategyAssetBreakdown, VaultTokenStatus, VaultTokenTotals} from "./IVaultReportingTypes.sol";

/**
 * @title IL1TreasuryVault
 * @notice L1 treasury vault interface for custody, strategy allocation, and L1->L2 bridging.
 * @dev All strategy/accounting flows use ERC20 token addresses directly.
 */
interface IL1TreasuryVault {
    // --------- Errors ---------
    /// @dev Caller does not hold required role.
    error Unauthorized();
    /// @dev Operation is blocked while vault is paused.
    error Paused();
    /// @dev Principal token is not enabled for normal operations.
    error TokenNotSupported();
    /// @dev Strategy is not authorized for the requested principal token domain.
    error StrategyNotWhitelisted();
    /// @dev Generic invalid input/config guard.
    error InvalidParam();
    /// @dev Operation exceeds configured cap.
    error CapExceeded();
    /// @dev Native ETH payout/transfer failed.
    error NativeTransferFailed();
    /// @dev Strategy `assets` read failed or returned malformed data.
    error InvalidStrategyAssetsRead(address token, address strategy);
    /// @dev Strategy scalar exposure read failed.
    error InvalidStrategyExposureRead(address token, address strategy);
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

    /// @notice Role allowed to allocate/deallocate strategy principal.
    function ALLOCATOR_ROLE() external view returns (bytes32);

    /// @notice Role allowed to pause and unpause risk-taking actions.
    function PAUSER_ROLE() external view returns (bytes32);

    /// @notice Returns whether `account` currently holds `role`.
    function hasRole(bytes32 role, address account) external view returns (bool);

    // --------- Core config ---------
    /// @notice BridgeHub contract used to submit L1 -> L2 bridge requests.
    function bridgeHub() external view returns (address);

    /// @notice Base token contract used to fund bridge `mintValue`.
    function baseToken() external view returns (address);

    /// @notice Target L2 chain id for all bridge submissions.
    function l2ChainId() external view returns (uint256);

    /// @notice L2 recipient that receives bridged funds.
    function l2ExchangeRecipient() external view returns (address);

    /// @notice Wrapped native token used for internal ERC20 accounting of native exposure.
    function wrappedNativeToken() external view returns (address);

    /// @notice Native bridge gateway used for L1 -> L2 native bridge sends and failed-deposit recovery.
    function nativeBridgeGateway() external view returns (address);

    /// @notice Recipient that receives harvested yield and native sweep funds.
    function yieldRecipient() external view returns (address);

    /// @notice Timelock controller authorized to update yield recipient.
    function yieldRecipientTimelockController() external view returns (address);

    /// @notice Returns true when vault is paused.
    function paused() external view returns (bool);

    /// @notice Enters paused mode for risk-taking operations.
    /// @dev Implementations should restrict this call to pauser/admin authority.
    function pause() external;

    /// @notice Exits paused mode.
    /// @dev Implementations should restrict this call to pauser/admin authority.
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
    /// @notice Principal-token enablement configuration.
    struct PrincipalTokenConfig {
        /// @dev True if token is enabled for normal allocate/rebalance operations.
        bool supported;
    }

    /// @notice Returns support config for `principalToken`.
    function getPrincipalTokenConfig(address principalToken) external view returns (PrincipalTokenConfig memory);

    /// @notice Sets support config for `principalToken`.
    /// @dev Implementations should validate token address and enforce admin-only access.
    function setPrincipalTokenConfig(address principalToken, PrincipalTokenConfig calldata cfg) external;

    // --------- Strategy registry (whitelist) ---------
    /// @notice Strategy policy for one `(principalToken, strategy)` binding.
    struct PrincipalStrategyConfig {
        /// @dev True allows new allocations.
        bool whitelisted;
        /// @dev True keeps strategy in active withdraw/reporting set.
        bool active;
        /// @dev Allocation cap for this binding. `0` means uncapped.
        uint256 cap;
    }

    /// @notice Returns whether strategy is currently allocatable for `principalToken`.
    function isStrategyWhitelistedForPrincipal(address principalToken, address strategy) external view returns (bool);

    /// @notice Returns full strategy config for one `(principalToken, strategy)` binding.
    function getPrincipalStrategyConfig(
        address principalToken,
        address strategy
    ) external view returns (PrincipalStrategyConfig memory);

    /// @notice Returns active strategy list for `principalToken`.
    /// @dev Includes withdraw-only active entries if implementation keeps lifecycle split.
    function getPrincipalTokenStrategies(address principalToken) external view returns (address[] memory);

    /// @notice Sets whitelist/cap policy for one `(principalToken, strategy)` binding.
    /// @dev Implementations may derive lifecycle fields (such as `active`) internally.
    function setPrincipalStrategyWhitelist(
        address principalToken,
        address strategy,
        PrincipalStrategyConfig calldata cfg
    ) external;

    // --------- Accounting / views ---------
    /// @notice Returns idle balance held directly by vault for `token`.
    function idleTokenBalance(address token) external view returns (uint256);

    /// @notice Returns principal-domain position breakdown reported by `strategy` for `principalToken`.
    /// @dev Components remain in exact token units; no denomination conversion is implied by the vault.
    function strategyPositionBreakdown(
        address principalToken,
        address strategy
    ) external view returns (StrategyAssetBreakdown memory);

    /// @notice Returns strict exact-token totals (`idle`, `strategy`, `total`) for `queryToken`.
    /// @dev Strict variant may revert when strategy reads are invalid.
    function totalExactAssets(address queryToken) external view returns (VaultTokenTotals memory);

    /// @notice Returns degraded exact-token totals with skip accounting for invalid strategy reads.
    function totalExactAssetsStatus(address queryToken) external view returns (VaultTokenStatus memory);

    /// @notice Returns tracked principal-token registry used for TVL token discovery.
    /// @dev Storage-backed read; should not perform strategy external calls.
    function getTrackedPrincipalTokens() external view returns (address[] memory);

    /// @notice Returns whether `principalToken` is currently in tracked-principal registry.
    function isTrackedPrincipalToken(address principalToken) external view returns (bool);

    /// @notice Batch variant of `totalExactAssetsStatus`.
    /// @dev Output ordering is stable: `statuses[i]` corresponds to `queryTokens[i]`.
    function totalExactAssetsBatch(address[] calldata queryTokens) external view returns (VaultTokenStatus[] memory);

    /// @notice Returns conservative immediate native amount bridgeable without strategy withdrawal.
    /// @dev Native availability is measured through wrapped-native idle accounting.
    function availableNativeForRebalance() external view returns (uint256);

    /// @notice Returns conservative immediate ERC20 amount bridgeable without strategy withdrawal.
    function availableErc20ForRebalance(address erc20Token) external view returns (uint256);

    // --------- Yield operations (via whitelisted strategies) ---------
    /// @notice Emitted when principal is allocated from vault idle to a strategy.
    /// @param principalToken Principal token domain.
    /// @param strategy Strategy receiving allocation.
    /// @param amount Requested allocation amount.
    event PrincipalAllocatedToStrategy(address indexed principalToken, address indexed strategy, uint256 amount);

    /// @notice Emitted when principal is deallocated from strategy back to vault idle.
    /// @param principalToken Principal token domain.
    /// @param strategy Strategy source.
    /// @param requested Requested withdrawal amount (or implementation max marker).
    /// @param received Actual measured amount received by vault.
    event PrincipalDeallocatedFromStrategy(
        address indexed principalToken,
        address indexed strategy,
        uint256 requested,
        uint256 received
    );

    /// @notice Emitted when strategy reported amount differs from measured vault balance delta.
    event StrategyReportedReceivedMismatch(
        address indexed principalToken,
        address indexed strategy,
        uint256 requested,
        uint256 reported,
        uint256 actual
    );

    /// @notice Emitted when tracked principal value changes for a `(token, strategy)` pair.
    event StrategyPrincipalUpdated(
        address indexed principalToken,
        address indexed strategy,
        uint256 previousPrincipal,
        uint256 newPrincipal
    );

    /// @notice Emitted when tracked-principal override policy is changed.
    event TrackedPrincipalOverrideUpdated(address indexed principalToken, bool enabled, bool forceTrack);

    /// @notice Emitted when harvest payout is transferred to yield recipient.
    event YieldHarvested(
        address indexed principalToken,
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

    /// @notice Allocates vault idle principal into an approved strategy.
    /// @param principalToken Principal token to allocate.
    /// @param strategy Strategy target.
    /// @param amount Allocation amount.
    function allocatePrincipalToStrategy(address principalToken, address strategy, uint256 amount) external;

    /// @notice Deallocates principal from strategy back into vault idle balance.
    /// @param principalToken Principal token domain.
    /// @param strategy Strategy source.
    /// @param amount Requested amount to withdraw.
    /// @return received Actual measured amount received by vault.
    function deallocatePrincipalFromStrategy(
        address principalToken,
        address strategy,
        uint256 amount
    ) external returns (uint256 received);

    /// @notice Deallocates all strategy-held principal for a token domain.
    /// @param principalToken Principal token domain.
    /// @param strategy Strategy source.
    /// @return received Actual measured amount received by vault.
    function deallocateAllPrincipalFromStrategy(
        address principalToken,
        address strategy
    ) external returns (uint256 received);

    /// @notice Returns tracked principal baseline for one `(principalToken, strategy)` pair.
    function strategyPrincipal(address principalToken, address strategy) external view returns (uint256);

    /// @notice Returns currently harvestable yield for one `(principalToken, strategy)` pair.
    function harvestableYield(address principalToken, address strategy) external view returns (uint256);

    /// @notice Harvests strategy yield and pays configured yield recipient.
    function harvestYieldFromStrategy(
        address principalToken,
        address strategy,
        uint256 amount,
        uint256 minReceived
    ) external returns (uint256 received);

    /// @notice Sets break-glass tracked-principal override for one token.
    function setTrackedPrincipalOverride(address principalToken, bool enabled, bool forceTrack) external;

    /// @notice Sweeps native ETH balance from vault to yield recipient.
    /// @param amount Native ETH amount to transfer.
    function sweepNativeToYieldRecipient(uint256 amount) external;

    // --------- Rebalancing between L1 vault and L2 exchange ---------
    /// @notice Emitted for normal native bridge rebalances.
    event NativeRebalancedToL2(
        /// @param amount Native ETH amount bridged.
        uint256 amount,
        /// @param l2TxGasLimit L2 gas limit used for bridge request.
        uint256 l2TxGasLimit,
        /// @param l2TxGasPerPubdataByte L2 pubdata gas setting used for bridge request.
        uint256 l2TxGasPerPubdataByte,
        /// @param refundRecipient Recipient configured for bridge refunds.
        address indexed refundRecipient,
        /// @param bridgeTxHash Returned L2 transaction hash identifier.
        bytes32 bridgeTxHash
    );

    /// @notice Emitted for normal ERC20 bridge rebalances.
    event Erc20RebalancedToL2(
        /// @param erc20Token ERC20 token bridged.
        address indexed erc20Token,
        /// @param amount Token amount bridged.
        uint256 amount,
        /// @param l2TxGasLimit L2 gas limit used for bridge request.
        uint256 l2TxGasLimit,
        /// @param l2TxGasPerPubdataByte L2 pubdata gas setting used for bridge request.
        uint256 l2TxGasPerPubdataByte,
        /// @param refundRecipient Recipient configured for bridge refunds.
        address indexed refundRecipient,
        /// @param bridgeTxHash Returned L2 transaction hash identifier.
        bytes32 bridgeTxHash
    );

    /// @notice Bridges native ETH intent to L2 exchange recipient.
    /// @param amount Native amount to bridge.
    /// @dev Implementations should enforce `msg.value == 0` and fund bridge cost via base token minting.
    function rebalanceNativeToL2(uint256 amount) external payable;

    /// @notice Bridges ERC20 token to L2 exchange recipient.
    /// @param erc20Token ERC20 token to bridge (wrapped native should be rejected on this path).
    /// @param amount Token amount to bridge.
    /// @dev Implementations should enforce `msg.value == 0` and fund bridge cost via base token minting.
    function rebalanceErc20ToL2(address erc20Token, uint256 amount) external payable;

    // --------- Emergency: force funds back to exchange ---------
    /// @notice Emitted for emergency native bridge sends.
    event NativeEmergencySentToL2(
        /// @param amount Native ETH amount bridged.
        uint256 amount,
        /// @param l2TxGasLimit L2 gas limit used for bridge request.
        uint256 l2TxGasLimit,
        /// @param l2TxGasPerPubdataByte L2 pubdata gas setting used for bridge request.
        uint256 l2TxGasPerPubdataByte,
        /// @param refundRecipient Recipient configured for bridge refunds.
        address indexed refundRecipient,
        /// @param bridgeTxHash Returned L2 transaction hash identifier.
        bytes32 bridgeTxHash
    );

    /// @notice Emitted for emergency ERC20 bridge sends.
    event Erc20EmergencySentToL2(
        /// @param erc20Token ERC20 token bridged.
        address indexed erc20Token,
        /// @param amount Token amount bridged.
        uint256 amount,
        /// @param l2TxGasLimit L2 gas limit used for bridge request.
        uint256 l2TxGasLimit,
        /// @param l2TxGasPerPubdataByte L2 pubdata gas setting used for bridge request.
        uint256 l2TxGasPerPubdataByte,
        /// @param refundRecipient Recipient configured for bridge refunds.
        address indexed refundRecipient,
        /// @param bridgeTxHash Returned L2 transaction hash identifier.
        bytes32 bridgeTxHash
    );

    /// @notice Emergency native bridge path callable under incident conditions.
    /// @param amount Native amount to bridge.
    /// @dev Emergency flow may bypass normal support/pause policy depending on implementation.
    function emergencyNativeToL2(uint256 amount) external payable;

    /// @notice Emergency ERC20 bridge path callable under incident conditions.
    /// @param erc20Token ERC20 token to bridge.
    /// @param amount Token amount to bridge.
    /// @dev Emergency flow may bypass normal support/pause policy depending on implementation.
    function emergencyErc20ToL2(address erc20Token, uint256 amount) external payable;
}
