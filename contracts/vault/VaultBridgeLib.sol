// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";
import {IGRVTBridgeProxyFeeToken} from "../external/IGRVTBridgeProxyFeeToken.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";

library VaultBridgeLib {
    using SafeERC20 for IERC20;

    /**
     * @notice Emitted for all successful L1 -> L2 bridge sends initiated through the vault.
     */
    event BridgeSentToL2(
        address indexed token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address indexed refundRecipient,
        bytes32 bridgeTxHash,
        bool isNative
    );

    /**
     * @notice Shared bridge request parameters used by the standard bridge path.
     */
    struct BridgeRequest {
        address bridgeHub;
        address grvtBridgeProxyFeeToken;
        uint256 l2ChainId;
        address l2ExchangeRecipient;
        address wrappedNativeToken;
        uint256 l2TxGasLimit;
        uint256 l2TxGasPerPubdataByte;
        address token;
        uint256 amount;
        bool isNativeIntent;
    }

    /**
     * @notice Validates the standard bridge path against current idle balance and token support.
     */
    function ensureStandardBridgeOut(BridgeRequest memory request, bool tokenSupported) public view {
        _requireBridgeRequestConfigured(request);
        (bool ok, uint256 idle) = _tryBalanceOf(request.token, address(this));
        if (!ok || idle < request.amount) revert IL1TreasuryVault.InvalidParam();
        if (!tokenSupported) revert IL1TreasuryVault.TokenNotSupported();
    }

    /**
     * @notice Executes the two-bridges L1 -> L2 request against BridgeHub.
     */
    function bridgeToL2TwoBridges(BridgeRequest memory request) public returns (bytes32 txHash) {
        IL1ZkSyncBridgeHub hub = IL1ZkSyncBridgeHub(request.bridgeHub);
        address sharedBridge = hub.sharedBridge();
        if (sharedBridge == address(0)) revert IL1TreasuryVault.InvalidParam();

        uint256 baseCost = hub.l2TransactionBaseCost(
            request.l2ChainId,
            tx.gasprice,
            request.l2TxGasLimit,
            request.l2TxGasPerPubdataByte
        );

        IGRVTBridgeProxyFeeToken(request.grvtBridgeProxyFeeToken).mint(address(this), baseCost);

        if (request.isNativeIntent || request.token == request.wrappedNativeToken) {
            revert IL1TreasuryVault.InvalidParam();
        }

        bool needsBaseApprove = request.token != request.grvtBridgeProxyFeeToken;

        if (request.token == request.grvtBridgeProxyFeeToken) {
            IERC20(request.token).forceApprove(sharedBridge, request.amount + baseCost);
        } else {
            IERC20(request.token).forceApprove(sharedBridge, request.amount);
        }
        if (needsBaseApprove) {
            IERC20(request.grvtBridgeProxyFeeToken).forceApprove(sharedBridge, baseCost);
        }

        txHash = hub.requestL2TransactionTwoBridges(
            L2TransactionRequestTwoBridgesOuter({
                chainId: request.l2ChainId,
                mintValue: baseCost,
                l2Value: 0,
                l2GasLimit: request.l2TxGasLimit,
                l2GasPerPubdataByteLimit: request.l2TxGasPerPubdataByte,
                refundRecipient: request.l2ExchangeRecipient,
                secondBridgeAddress: sharedBridge,
                secondBridgeValue: 0,
                secondBridgeCalldata: abi.encode(request.token, request.amount, request.l2ExchangeRecipient)
            })
        );

        IERC20(request.token).forceApprove(sharedBridge, 0);
        if (needsBaseApprove) {
            IERC20(request.grvtBridgeProxyFeeToken).forceApprove(sharedBridge, 0);
        }
    }

    /**
     * @notice Emits the unified bridge event for the completed request.
     */
    function emitBridgeEvent(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient,
        bytes32 txHash,
        bool isNativeIntent
    ) public {
        emit BridgeSentToL2(
            token,
            amount,
            l2TxGasLimit,
            l2TxGasPerPubdataByte,
            refundRecipient,
            txHash,
            isNativeIntent
        );
    }

    /**
     * @notice Sends native ETH and normalizes failure to the vault's custom error surface.
     */
    function sendNative(address recipient, uint256 amount) public {
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert IL1TreasuryVault.NativeTransferFailed();
    }

    /**
     * @notice Validates that a bridge request contains the minimum non-zero wiring required for execution.
     */
    function _requireBridgeRequestConfigured(BridgeRequest memory request) private pure {
        if (
            request.amount == 0 ||
            request.bridgeHub == address(0) ||
            request.grvtBridgeProxyFeeToken == address(0) ||
            request.l2ChainId == 0 ||
            request.l2ExchangeRecipient == address(0)
        ) {
            revert IL1TreasuryVault.InvalidParam();
        }
    }

    /**
     * @notice Performs a defensive ERC20 `balanceOf` probe for bridge readiness checks.
     */
    function _tryBalanceOf(address token, address account) private view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (!success || data.length < 32) {
            return (false, 0);
        }
        return (true, abi.decode(data, (uint256)));
    }
}
