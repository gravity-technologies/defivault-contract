// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";
import {IWrappedNative} from "../external/IWrappedNative.sol";
import {ZkSyncAssetRouterEncoding} from "../external/ZkSyncAssetRouterEncoding.sol";
import {INativeBridgeGateway} from "../interfaces/INativeBridgeGateway.sol";

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
 *      - If a native deposit later fails on zkSync, BridgeHub recovery is claimed externally back to this gateway.
 *      - `recoverClaimedNativeDeposit` then wraps the already-claimed ETH and returns the normalized funds to the vault.
 *
 *      Native bridge payloads use Matter Labs' current asset-router sentinel for ETH (`address(1)`),
 *      centralized via `ZkSyncAssetRouterEncoding` so production code and mocks/tests stay aligned.
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
     * @notice Wraps ETH already reclaimed to this gateway and returns it to the vault as wrapped-native.
     * @dev Assumes an external caller has already executed the BridgeHub failed-deposit claim with this gateway as
     *      the `depositSender`, causing the native ETH to be delivered to `address(this)`.
     * @param bridgeTxHash Canonical L2 tx hash returned at bridge submission time.
     */
    function recoverClaimedNativeDeposit(bytes32 bridgeTxHash) external {
        NativeBridgeRecord storage record = nativeBridgeRecords[bridgeTxHash];
        if (record.amount == 0) revert NativeBridgeRecordNotFound(bridgeTxHash);
        if (record.recovered) revert NativeBridgeAlreadyRecovered(bridgeTxHash);

        uint256 recovered = record.amount;
        if (address(this).balance < recovered) revert InvalidParam();
        record.recovered = true;

        IWrappedNative(wrappedNativeToken).deposit{value: recovered}();
        IERC20(wrappedNativeToken).safeTransfer(vault, recovered);

        emit FailedNativeDepositRecovered(bridgeTxHash, recovered);
    }

    /**
     * @notice Accepts ETH only from wrapped-native unwraps or the configured shared bridge.
     */
    receive() external payable {
        if (msg.sender == wrappedNativeToken) return;
        if (msg.sender == IL1ZkSyncBridgeHub(bridgeHub).sharedBridge()) return;
        revert UnexpectedNativeSender(msg.sender);
    }

    /**
     * @notice Rejects calldata-bearing sends.
     */
    fallback() external payable {
        revert InvalidParam();
    }
}
