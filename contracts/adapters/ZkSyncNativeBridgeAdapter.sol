// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IZkSyncL1Bridge} from "../external/IZkSyncL1Bridge.sol";
import {IExchangeBridgeAdapter} from "../interfaces/IExchangeBridgeAdapter.sol";

/**
 * @title ZkSyncNativeBridgeAdapter
 * @notice IExchangeBridgeAdapter implementation that routes vault outflows through the zkSync
 *         native L1 ERC20 bridge. Each call to `sendToL2` pulls tokens from the vault (via
 *         pre-approved allowance), deposits them into the zkSync L1 bridge, and returns the
 *         bridge's transaction hash for traceability.
 *
 * @dev ## Key behaviors
 *
 *      ### sendToL2 flow
 *        1. Pull `amount` of `token` from `vault` to this adapter (requires vault to have
 *           called `token.approve(adapter, amount)` before the call).
 *        2. Approve `zkSyncBridge` for exactly `amount`.
 *        3. Call `IZkSyncL1Bridge.deposit{value: msg.value}(...)`, forwarding the full ETH
 *           value as the bridge fee. The bridge returns a `bytes32` txHash.
 *        4. Reset the bridge allowance to 0.
 *        5. Emit `SentToL2` with all routing parameters and the txHash.
 *
 *      ### Time-locked address updates
 *      Both `vault` and `zkSyncBridge` are mutable but gated behind a `UPDATE_DELAY` timelock
 *      to prevent instantaneous redirection of funds under a compromised admin key:
 *        - Call `proposeVaultUpdate` / `proposeZkSyncBridgeUpdate` to queue a change.
 *        - Call `applyVaultUpdate` / `applyZkSyncBridgeUpdate` after the delay has elapsed
 *          to commit it.
 *      At most one pending proposal exists per field. A new proposal cannot be queued until
 *      the current one is either applied or explicitly cancelled.
 *
 *      ### Trusted inbound callers
 *      `_trustedInboundCallers` is a whitelist for future L2 → L1 inbound hook callers
 *      (e.g. a bridge relayer that notifies the vault of incoming L2 withdrawals).
 *      It has no effect on the outbound `sendToL2` path.
 *
 *      ### Authorization boundary
 *      Only `vault` may call `sendToL2`. All config mutations require ADAPTER_ADMIN_ROLE.
 *
 *      ### Upgrade safety
 *      A `__gap` array reserves storage slots for future layout additions without
 *      colliding with proxy storage.
 */
contract ZkSyncNativeBridgeAdapter is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    IExchangeBridgeAdapter
{
    // ============================================= Constants ======================================================
    using SafeERC20 for IERC20;

    /// @notice Governance role that controls config mutations (vault address, bridge address, trusted callers).
    bytes32 public constant ADAPTER_ADMIN_ROLE = keccak256("ADAPTER_ADMIN_ROLE");

    /// @notice Minimum delay between proposing and applying a vault or bridge address update.
    /// @dev Prevents an instant fund-redirection attack if an admin key is compromised.
    uint64 public constant UPDATE_DELAY = 1 days;

    // ============================================= Storage (Public/Private) =======================================

    /// @notice The vault contract authorized to call `sendToL2`. Only one vault is active at a time.
    address public vault;

    /// @notice The zkSync L1 ERC20 bridge contract that receives token deposits.
    address public zkSyncBridge;

    /// @notice Pending vault address queued by `proposeVaultUpdate`. Zero if no proposal is active.
    address public pendingVault;

    /// @notice Earliest timestamp at which `applyVaultUpdate` may be called. Zero if no proposal is active.
    /// @dev Packed with `pendingVault` (address + uint64 = 28 bytes, fits in one 32-byte slot).
    uint64 public pendingVaultReadyAt;

    /// @notice Pending bridge address queued by `proposeZkSyncBridgeUpdate`. Zero if no proposal is active.
    address public pendingZkSyncBridge;

    /// @notice Earliest timestamp at which `applyZkSyncBridgeUpdate` may be called. Zero if no proposal is active.
    /// @dev Packed with `pendingZkSyncBridge` (address + uint64 = 28 bytes, fits in one 32-byte slot).
    uint64 public pendingZkSyncBridgeReadyAt;

    /// @dev Whitelist of addresses permitted to act as trusted inbound callers (L2 → L1 hooks).
    ///      Has no effect on the outbound `sendToL2` path.
    mapping(address caller => bool allowed) private _trustedInboundCallers;

    /// @dev Reserved storage gap for future upgrade-safe layout additions.
    uint256[50] private __gap;

    // =============================================== Errors ===================================================

    /// @dev Thrown by `onlyVault` when msg.sender is not the currently configured vault.
    error Unauthorized();

    /// @dev Thrown when a zero address or zero amount is passed to a function that requires a non-zero value.
    error InvalidParam();

    /// @dev Thrown by `applyVaultUpdate` or `applyZkSyncBridgeUpdate` when no proposal is pending.
    error NoPendingUpdate();

    /// @dev Thrown by `applyVaultUpdate` or `applyZkSyncBridgeUpdate` when `block.timestamp < readyAt`.
    error PendingUpdateNotReady();

    /// @dev Thrown by `proposeVaultUpdate` / `proposeZkSyncBridgeUpdate` when a pending update already exists.
    error PendingUpdateExists();

    // =============================================== Events ===================================================

    /**
     * @notice Emitted after a successful `sendToL2` call.
     * @param token                  ERC20 token deposited into the bridge.
     * @param amount                 Token amount deposited.
     * @param l2Recipient            L2 address that will receive the tokens.
     * @param l2TxGasLimit           Gas limit for the L2 execution leg.
     * @param l2TxGasPerPubdataByte  Gas price per pubdata byte for the L2 transaction.
     * @param refundRecipient        Address to receive any surplus bridge fee on L2.
     * @param bridgeTxHash           Transaction hash returned by the zkSync L1 bridge.
     */
    event SentToL2(
        address indexed token,
        uint256 amount,
        address indexed l2Recipient,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient,
        bytes32 bridgeTxHash
    );

    /// @notice Emitted when a trusted inbound caller is added or removed.
    event TrustedInboundCallerSet(address indexed caller, bool allowed);

    /// @notice Emitted when a pending vault update is committed via `applyVaultUpdate`.
    event VaultUpdated(address indexed previousVault, address indexed newVault);

    /// @notice Emitted when a pending bridge update is committed via `applyZkSyncBridgeUpdate`.
    event ZkSyncBridgeUpdated(address indexed previousBridge, address indexed newBridge);

    /**
     * @notice Emitted when a vault update is proposed via `proposeVaultUpdate`.
     * @param pendingVault The proposed new vault address.
     * @param readyAt      Earliest timestamp at which the update may be applied.
     */
    event VaultUpdateProposed(address indexed pendingVault, uint64 readyAt);

    /**
     * @notice Emitted when a bridge update is proposed via `proposeZkSyncBridgeUpdate`.
     * @param pendingBridge The proposed new bridge address.
     * @param readyAt       Earliest timestamp at which the update may be applied.
     */
    event ZkSyncBridgeUpdateProposed(address indexed pendingBridge, uint64 readyAt);

    /// @notice Emitted when a pending vault update is cancelled.
    event VaultUpdateCancelled(address indexed cancelledPendingVault);

    /// @notice Emitted when a pending bridge update is cancelled.
    event ZkSyncBridgeUpdateCancelled(address indexed cancelledPendingBridge);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable adapter.
     * @dev Sets up role hierarchy: DEFAULT_ADMIN_ROLE administers ADAPTER_ADMIN_ROLE.
     *      `admin` receives both roles. An optional `trustedInboundCaller` may be registered
     *      at construction; pass `address(0)` to skip.
     * @param admin                  Initial admin account (receives DEFAULT_ADMIN_ROLE and ADAPTER_ADMIN_ROLE).
     * @param vault_                 Vault address authorized to call `sendToL2`. Must be non-zero.
     * @param zkSyncBridge_          zkSync L1 bridge address to deposit into. Must be non-zero.
     * @param trustedInboundCaller   Optional initial trusted inbound caller. Ignored if zero.
     */
    function initialize(
        address admin,
        address vault_,
        address zkSyncBridge_,
        address trustedInboundCaller
    ) external initializer {
        if (admin == address(0) || vault_ == address(0) || zkSyncBridge_ == address(0)) revert InvalidParam();

        __AccessControl_init();
        __ReentrancyGuard_init();

        _setRoleAdmin(ADAPTER_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADAPTER_ADMIN_ROLE, admin);

        vault = vault_;
        zkSyncBridge = zkSyncBridge_;

        if (trustedInboundCaller != address(0)) {
            _trustedInboundCallers[trustedInboundCaller] = true;
            emit TrustedInboundCallerSet(trustedInboundCaller, true);
        }
    }

    /// @dev Reverts if msg.sender is not the currently configured `vault`.
    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    /// @dev Accept ETH refunds from bridge calls that send surplus fee value back to msg.sender.
    receive() external payable {}

    /**
     * @inheritdoc IExchangeBridgeAdapter
     * @dev Execution flow:
     *        1. Pull `amount` of `token` from `vault` to this adapter using the vault's
     *           pre-approved allowance (`safeTransferFrom`).
     *        2. Approve `zkSyncBridge` for exactly `amount`.
     *        3. Call `IZkSyncL1Bridge.deposit{value: msg.value}(...)`, forwarding the full
     *           ETH value as the bridge fee. No ETH is retained by this adapter.
     *        4. Reset the bridge's allowance to 0.
     *        5. Return the bridge's txHash and emit `SentToL2`.
     *
     *      All six parameters must be non-zero. Reverts propagate from the bridge call.
     */
    function sendToL2(
        address token,
        uint256 amount,
        address l2Recipient,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient
    ) external payable override onlyVault nonReentrant returns (bytes32 txHash) {
        if (
            token == address(0) ||
            amount == 0 ||
            l2Recipient == address(0) ||
            l2TxGasLimit == 0 ||
            l2TxGasPerPubdataByte == 0 ||
            refundRecipient == address(0)
        ) revert InvalidParam();

        IERC20(token).safeTransferFrom(vault, address(this), amount);
        IERC20(token).forceApprove(zkSyncBridge, amount);
        txHash = IZkSyncL1Bridge(zkSyncBridge).deposit{value: msg.value}(
            l2Recipient,
            token,
            amount,
            l2TxGasLimit,
            l2TxGasPerPubdataByte,
            refundRecipient
        );
        IERC20(token).forceApprove(zkSyncBridge, 0);

        emit SentToL2(token, amount, l2Recipient, l2TxGasLimit, l2TxGasPerPubdataByte, refundRecipient, txHash);
    }

    /// @inheritdoc IExchangeBridgeAdapter
    function isTrustedInboundCaller(address caller) external view override returns (bool) {
        return _trustedInboundCallers[caller];
    }

    /**
     * @notice Adds or removes an address from the trusted inbound caller whitelist.
     * @param caller  The address to configure. Must be non-zero.
     * @param allowed True to grant trust; false to revoke.
     */
    function setTrustedInboundCaller(address caller, bool allowed) external onlyRole(ADAPTER_ADMIN_ROLE) {
        if (caller == address(0)) revert InvalidParam();
        _trustedInboundCallers[caller] = allowed;
        emit TrustedInboundCallerSet(caller, allowed);
    }

    /**
     * @notice Proposes a new vault address to take effect after `UPDATE_DELAY`.
     * @dev Emits `VaultUpdateProposed`. Call `applyVaultUpdate` after the delay to commit.
     *      Reverts with `PendingUpdateExists` if a vault update is already pending.
     * @param newVault The proposed replacement vault address. Must be non-zero.
     */
    function proposeVaultUpdate(address newVault) external onlyRole(ADAPTER_ADMIN_ROLE) {
        if (newVault == address(0)) revert InvalidParam();
        if (pendingVault != address(0)) revert PendingUpdateExists();

        uint64 readyAt = uint64(block.timestamp + UPDATE_DELAY);
        pendingVault = newVault;
        pendingVaultReadyAt = readyAt;

        emit VaultUpdateProposed(newVault, readyAt);
    }

    /**
     * @notice Cancels the pending vault update without applying it.
     * @dev Reverts with `NoPendingUpdate` if no proposal exists.
     */
    function cancelVaultUpdate() external onlyRole(ADAPTER_ADMIN_ROLE) {
        address cancelled = pendingVault;
        if (cancelled == address(0)) revert NoPendingUpdate();

        delete pendingVault;
        delete pendingVaultReadyAt;

        emit VaultUpdateCancelled(cancelled);
    }

    /**
     * @notice Commits the pending vault update if the timelock delay has elapsed.
     * @dev Clears `pendingVault` and `pendingVaultReadyAt` after applying.
     *      Reverts with `NoPendingUpdate` if no proposal exists, or `PendingUpdateNotReady`
     *      if `block.timestamp < pendingVaultReadyAt`.
     */
    function applyVaultUpdate() external onlyRole(ADAPTER_ADMIN_ROLE) {
        address next = pendingVault;
        uint64 readyAt = pendingVaultReadyAt;
        if (next == address(0)) revert NoPendingUpdate();
        if (block.timestamp < uint256(readyAt)) revert PendingUpdateNotReady();

        address previous = vault;
        vault = next;
        delete pendingVault;
        delete pendingVaultReadyAt;

        emit VaultUpdated(previous, next);
    }

    /**
     * @notice Proposes a new zkSync L1 bridge address to take effect after `UPDATE_DELAY`.
     * @dev Emits `ZkSyncBridgeUpdateProposed`. Call `applyZkSyncBridgeUpdate` after the delay to commit.
     *      Reverts with `PendingUpdateExists` if a bridge update is already pending.
     * @param newBridge The proposed replacement bridge address. Must be non-zero.
     */
    function proposeZkSyncBridgeUpdate(address newBridge) external onlyRole(ADAPTER_ADMIN_ROLE) {
        if (newBridge == address(0)) revert InvalidParam();
        if (pendingZkSyncBridge != address(0)) revert PendingUpdateExists();

        uint64 readyAt = uint64(block.timestamp + UPDATE_DELAY);
        pendingZkSyncBridge = newBridge;
        pendingZkSyncBridgeReadyAt = readyAt;

        emit ZkSyncBridgeUpdateProposed(newBridge, readyAt);
    }

    /**
     * @notice Cancels the pending zkSync bridge update without applying it.
     * @dev Reverts with `NoPendingUpdate` if no proposal exists.
     */
    function cancelZkSyncBridgeUpdate() external onlyRole(ADAPTER_ADMIN_ROLE) {
        address cancelled = pendingZkSyncBridge;
        if (cancelled == address(0)) revert NoPendingUpdate();

        delete pendingZkSyncBridge;
        delete pendingZkSyncBridgeReadyAt;

        emit ZkSyncBridgeUpdateCancelled(cancelled);
    }

    /**
     * @notice Commits the pending zkSync bridge update if the timelock delay has elapsed.
     * @dev Clears `pendingZkSyncBridge` and `pendingZkSyncBridgeReadyAt` after applying.
     *      Reverts with `NoPendingUpdate` if no proposal exists, or `PendingUpdateNotReady`
     *      if `block.timestamp < pendingZkSyncBridgeReadyAt`.
     */
    function applyZkSyncBridgeUpdate() external onlyRole(ADAPTER_ADMIN_ROLE) {
        address next = pendingZkSyncBridge;
        uint64 readyAt = pendingZkSyncBridgeReadyAt;
        if (next == address(0)) revert NoPendingUpdate();
        if (block.timestamp < uint256(readyAt)) revert PendingUpdateNotReady();

        address previous = zkSyncBridge;
        zkSyncBridge = next;
        delete pendingZkSyncBridge;
        delete pendingZkSyncBridgeReadyAt;

        emit ZkSyncBridgeUpdated(previous, next);
    }
}
