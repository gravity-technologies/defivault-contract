// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IL1AssetRouter} from "../external/IL1AssetRouter.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";
import {ZkSyncAssetRouterEncoding} from "../external/ZkSyncAssetRouterEncoding.sol";
import {IL1SharedBridge} from "../interfaces/IL1SharedBridge.sol";
import {INativeBridgeGateway} from "../interfaces/INativeBridgeGateway.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";

/**
 * @title NativeBridgeGateway
 * @notice Vault-owned native bridge execution and failed-deposit recovery gateway.
 * @dev Why this exists:
 *      - zkSync failed-deposit recovery returns the bridged asset to the original L1 deposit sender.
 *      - If the vault were the native deposit sender, failed native deposits would attempt to send ETH back to the
 *        vault, violating the vault's "no direct ETH custody" invariant.
 *      - This gateway becomes the deposit sender for native bridge requests, accepts recovery ETH on that boundary,
 *        wraps it back into wrapped-native, and returns normalized funds to the vault.
 *
 *      Flow:
 *      - The vault transfers wrapped-native and the fee token into this gateway before `bridgeNativeToL2`.
 *      - If a native deposit later fails on zkSync, vault-admin recovery claims the ETH back to this gateway.
 *      - The gateway immediately wraps the claimed ETH and returns the normalized funds to the vault in the same
 *        transaction.
 *
 *      Native bridge payloads use Matter Labs' current asset-router sentinel for ETH (`address(1)`),
 *      centralized via `ZkSyncAssetRouterEncoding` so production code and mocks/tests stay aligned.
 *      Failed native-deposit refunds on the current zkSync stack are paid out by the shared bridge's
 *      currently configured native token vault, so this gateway resolves that sender dynamically at
 *      refund time instead of trusting stored sender configuration.
 *
 *      ### Upgrade safety
 *      Constructor logic is disabled on the implementation and all mutable configuration is assigned through
 *      `initialize`. A reserved `__gap` preserves storage layout extension room for future upgrades.
 */
contract NativeBridgeGateway is Initializable, INativeBridgeGateway {
    using SafeERC20 for IERC20;

    error InvalidParam();
    error Unauthorized();
    error UnexpectedNativeSender(address sender);
    error NativeBridgeRecordNotFound(bytes32 bridgeTxHash);
    error NativeBridgeAlreadyRecovered(bytes32 bridgeTxHash);
    error InvalidGatewayNativeBalance(uint256 actual, uint256 expected);
    error InvalidNativeClaimDelta(bytes32 bridgeTxHash, uint256 claimed, uint256 expected);

    struct NativeBridgeRecord {
        uint256 chainId;
        uint256 amount;
        bool recovered;
    }

    /// @notice Vault authorized to initiate native bridge sends.
    address public vault;

    /// @notice Canonical wrapped-native token bridged through this gateway.
    address public wrappedNativeToken;

    /// @notice GRVT bridge-proxy fee token used for BridgeHub `mintValue`.
    address public grvtBridgeProxyFeeToken;

    /// @notice zkSync BridgeHub used for native bridge submissions.
    address public bridgeHub;

    /// @notice Per-bridge record keyed by canonical L2 transaction hash.
    mapping(bytes32 bridgeTxHash => NativeBridgeRecord record) public nativeBridgeRecords;

    /// @dev Reserved storage gap for upgrade-safe layout extension.
    uint256[50] private __gap;

    /// @notice Emitted when native ETH is bridged out through BridgeHub.
    event NativeBridgedToL2(
        bytes32 indexed bridgeTxHash,
        uint256 chainId,
        uint256 amount,
        uint256 baseCost,
        address indexed l2Recipient,
        address indexed refundRecipient
    );

    /// @notice Emitted when a failed native deposit is reclaimed and re-wrapped back to the vault.
    event FailedNativeDepositRecovered(bytes32 indexed bridgeTxHash, uint256 amount);

    /// @notice Emitted when unexpected native ETH is normalized back into wrapped-native and returned to the vault.
    event UnexpectedNativeRecoveredToVault(uint256 amount);

    /// @notice Emitted when vault-admin rescue sweeps an ERC20 balance out of the gateway.
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable native bridge gateway.
     * @param wrappedNativeToken_ Wrapped-native token contract address.
     * @param grvtBridgeProxyFeeToken_ GRVT bridge-proxy fee token contract address.
     * @param bridgeHub_ BridgeHub contract address.
     * @param vault_ Vault address authorized to start native bridge sends.
     */
    function initialize(
        address wrappedNativeToken_,
        address grvtBridgeProxyFeeToken_,
        address bridgeHub_,
        address vault_
    ) external initializer {
        if (
            wrappedNativeToken_ == address(0) ||
            grvtBridgeProxyFeeToken_ == address(0) ||
            bridgeHub_ == address(0) ||
            vault_ == address(0)
        ) revert InvalidParam();
        if (
            wrappedNativeToken_.code.length == 0 ||
            grvtBridgeProxyFeeToken_.code.length == 0 ||
            bridgeHub_.code.length == 0 ||
            vault_.code.length == 0
        ) revert InvalidParam();

        address nativeTokenVault_ = _resolveNativeTokenVault(bridgeHub_);
        if (nativeTokenVault_ == address(0)) revert InvalidParam();

        wrappedNativeToken = wrappedNativeToken_;
        grvtBridgeProxyFeeToken = grvtBridgeProxyFeeToken_;
        bridgeHub = bridgeHub_;
        vault = vault_;
    }

    /**
     * @inheritdoc INativeBridgeGateway
     */
    function bridgeNativeToL2(
        uint256 chainId,
        uint256 l2GasLimit,
        uint256 l2GasPerPubdataByteLimit,
        address l2Recipient,
        address refundRecipient,
        uint256 amount,
        uint256 baseCost
    ) external override returns (bytes32 txHash) {
        if (msg.sender != vault) revert Unauthorized();
        if (
            chainId == 0 ||
            l2GasLimit == 0 ||
            l2GasPerPubdataByteLimit == 0 ||
            l2Recipient == address(0) ||
            refundRecipient == address(0) ||
            amount == 0
        ) revert InvalidParam();

        IL1ZkSyncBridgeHub hub = IL1ZkSyncBridgeHub(bridgeHub);
        address sharedBridge = hub.sharedBridge();
        if (sharedBridge == address(0)) revert InvalidParam();

        if (_resolveNativeTokenVaultFromSharedBridge(sharedBridge) == address(0)) revert InvalidParam();

        IWrappedNative(wrappedNativeToken).withdraw(amount);
        IERC20(grvtBridgeProxyFeeToken).forceApprove(sharedBridge, baseCost);

        txHash = hub.requestL2TransactionTwoBridges{value: amount}(
            L2TransactionRequestTwoBridgesOuter({
                chainId: chainId,
                mintValue: baseCost,
                l2Value: 0,
                l2GasLimit: l2GasLimit,
                l2GasPerPubdataByteLimit: l2GasPerPubdataByteLimit,
                refundRecipient: refundRecipient,
                secondBridgeAddress: sharedBridge,
                secondBridgeValue: amount,
                secondBridgeCalldata: ZkSyncAssetRouterEncoding.encodeLegacyNativeDeposit(amount, l2Recipient)
            })
        );

        IERC20(grvtBridgeProxyFeeToken).forceApprove(sharedBridge, 0);

        NativeBridgeRecord storage record = nativeBridgeRecords[txHash];
        if (record.amount != 0) revert InvalidParam();
        record.chainId = chainId;
        record.amount = amount;

        emit NativeBridgedToL2(txHash, chainId, amount, baseCost, l2Recipient, refundRecipient);
    }

    /**
     * @notice Claims a failed native deposit through the shared bridge and immediately returns the recovered value to
     *         the vault as wrapped-native.
     * @dev This function closes the claim/recovery race by ensuring the shared-bridge claim and the record-marking
     *      recovery happen in the same transaction against the exact stored record metadata.
     * @param bridgeTxHash Canonical L2 tx hash returned at bridge submission time.
     * @param l2BatchNumber Batch number containing the failed deposit.
     * @param l2MessageIndex Message index within the batch.
     * @param l2TxNumberInBatch Transaction number within the batch.
     * @param merkleProof Merkle proof authorizing the failed-deposit claim.
     */
    function claimAndRecoverFailedNativeDeposit(
        bytes32 bridgeTxHash,
        uint256 l2BatchNumber,
        uint256 l2MessageIndex,
        uint16 l2TxNumberInBatch,
        bytes32[] calldata merkleProof
    ) external {
        _requireVaultAdmin();

        NativeBridgeRecord storage record = nativeBridgeRecords[bridgeTxHash];
        _revertIfRecordNotRecoverable(record, bridgeTxHash);

        uint256 nativeBalanceBeforeClaim = address(this).balance;
        if (nativeBalanceBeforeClaim != 0) {
            revert InvalidGatewayNativeBalance(nativeBalanceBeforeClaim, 0);
        }

        address sharedBridge = IL1ZkSyncBridgeHub(bridgeHub).sharedBridge();
        if (sharedBridge == address(0)) revert InvalidParam();

        IL1SharedBridge(sharedBridge).claimFailedDeposit(
            record.chainId,
            address(this),
            ZkSyncAssetRouterEncoding.nativeTokenAddress(),
            record.amount,
            bridgeTxHash,
            l2BatchNumber,
            l2MessageIndex,
            l2TxNumberInBatch,
            merkleProof
        );

        uint256 claimed = address(this).balance - nativeBalanceBeforeClaim;
        if (claimed != record.amount) {
            revert InvalidNativeClaimDelta(bridgeTxHash, claimed, record.amount);
        }

        _recoverClaimedNativeDeposit(bridgeTxHash, record);
    }

    /**
     * @notice Wraps ETH already reclaimed to this gateway and returns it to the vault as wrapped-native.
     * @dev Assumes an external caller has already executed the BridgeHub failed-deposit claim with this gateway as
     *      the `depositSender`, causing the native ETH to be delivered to `address(this)`. Restricted to vault-admin
     *      callers and requires the gateway to hold exactly the recorded amount so mismatched native balances cannot
     *      be consumed against the wrong bridge record.
     * @param bridgeTxHash Canonical L2 tx hash returned at bridge submission time.
     */
    function recoverClaimedNativeDeposit(bytes32 bridgeTxHash) external {
        _requireVaultAdmin();

        NativeBridgeRecord storage record = nativeBridgeRecords[bridgeTxHash];
        _revertIfRecordNotRecoverable(record, bridgeTxHash);
        _recoverClaimedNativeDeposit(bridgeTxHash, record);
    }

    /**
     * @notice Normalizes unexpected native ETH already sitting on the gateway back into wrapped-native for the vault.
     * @param amount Native ETH amount to wrap and send back to the vault.
     */
    function recoverUnexpectedNativeToVault(uint256 amount) external {
        _requireVaultAdmin();
        if (amount == 0 || address(this).balance < amount) revert InvalidParam();

        _wrapAndTransferToVault(amount);
        emit UnexpectedNativeRecoveredToVault(amount);
    }

    /**
     * @notice Sweeps unexpected ERC20 balances held by the gateway.
     * @param token ERC20 token to sweep.
     * @param recipient Recipient of the swept tokens.
     * @param amount Token amount to sweep.
     */
    function sweepToken(address token, address recipient, uint256 amount) external {
        _requireVaultAdmin();
        if (token == address(0) || recipient == address(0) || amount == 0) revert InvalidParam();

        IERC20(token).safeTransfer(recipient, amount);
        emit TokenSwept(token, recipient, amount);
    }

    /**
     * @notice Accepts ETH only from wrapped-native unwraps or the live zkSync native token vault.
     */
    receive() external payable {
        if (msg.sender == wrappedNativeToken) return;
        if (msg.sender == _resolveNativeTokenVault(bridgeHub)) return;
        revert UnexpectedNativeSender(msg.sender);
    }

    /**
     * @notice Rejects calldata-bearing sends.
     */
    fallback() external payable {
        revert InvalidParam();
    }

    /**
     * @notice Resolves the zkSync native token vault used by the configured bridge stack.
     * @dev Reads `sharedBridge()` from `bridgeHub_`, then queries `nativeTokenVault()` on that
     *      shared bridge / asset-router surface. Returns `address(0)` when the bridge stack is
     *      misconfigured or does not expose the expected zkSync native-token-vault interface.
     * @param bridgeHub_ BridgeHub whose shared bridge should be inspected.
     * @return resolvedNativeTokenVault Native token vault for the current zkSync bridge stack.
     */
    function _resolveNativeTokenVault(address bridgeHub_) internal view returns (address resolvedNativeTokenVault) {
        address sharedBridge = IL1ZkSyncBridgeHub(bridgeHub_).sharedBridge();
        if (sharedBridge == address(0)) return address(0);

        return _resolveNativeTokenVaultFromSharedBridge(sharedBridge);
    }

    /**
     * @notice Resolves the zkSync native token vault exposed by a specific shared bridge.
     * @param sharedBridge Shared bridge / asset router exposing `nativeTokenVault()`.
     * @return resolvedNativeTokenVault Native token vault for the provided shared bridge.
     */
    function _resolveNativeTokenVaultFromSharedBridge(
        address sharedBridge
    ) internal view returns (address resolvedNativeTokenVault) {
        try IL1AssetRouter(sharedBridge).nativeTokenVault() returns (address nativeTokenVault_) {
            if (nativeTokenVault_ != address(0) && nativeTokenVault_.code.length != 0) {
                return nativeTokenVault_;
            }
        } catch {}

        return address(0);
    }

    /**
     * @notice Reverts unless the bridge record exists and has not already been recovered.
     * @param record Native bridge record storage pointer.
     * @param bridgeTxHash Canonical L2 tx hash keyed into `nativeBridgeRecords`.
     */
    function _revertIfRecordNotRecoverable(NativeBridgeRecord storage record, bytes32 bridgeTxHash) internal view {
        if (record.amount == 0) revert NativeBridgeRecordNotFound(bridgeTxHash);
        if (record.recovered) revert NativeBridgeAlreadyRecovered(bridgeTxHash);
    }

    /**
     * @notice Reverts unless the caller currently holds `VAULT_ADMIN_ROLE` on the configured vault.
     */
    function _requireVaultAdmin() internal view {
        IL1TreasuryVault treasuryVault = IL1TreasuryVault(vault);
        if (!treasuryVault.hasRole(treasuryVault.VAULT_ADMIN_ROLE(), msg.sender)) revert Unauthorized();
    }

    /**
     * @notice Wraps exactly `amount` native ETH from the gateway and returns the wrapped-native to the vault.
     * @param amount Native ETH amount to normalize back into wrapped-native.
     */
    function _wrapAndTransferToVault(uint256 amount) internal {
        IWrappedNative(wrappedNativeToken).deposit{value: amount}();
        IERC20(wrappedNativeToken).safeTransfer(vault, amount);
    }

    /**
     * @notice Marks a failed native deposit as recovered and returns its value to the vault as wrapped-native.
     * @param bridgeTxHash Canonical L2 tx hash returned at bridge submission time.
     * @param record Native bridge record keyed by `bridgeTxHash`.
     */
    function _recoverClaimedNativeDeposit(bytes32 bridgeTxHash, NativeBridgeRecord storage record) internal {
        uint256 recovered = record.amount;
        if (address(this).balance != recovered) {
            revert InvalidGatewayNativeBalance(address(this).balance, recovered);
        }

        record.recovered = true;
        _wrapAndTransferToVault(recovered);

        emit FailedNativeDepositRecovered(bridgeTxHash, recovered);
    }
}
