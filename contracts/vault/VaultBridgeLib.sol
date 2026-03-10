// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";
import {IGRVTBaseTokenMintable} from "../external/IGRVTBaseTokenMintable.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

library VaultBridgeLib {
    using SafeERC20 for IERC20;

    /**
     * @notice Emitted for all successful L1 -> L2 bridge sends initiated through the vault.
     * @param token Vault token used for the bridge flow.
     * @param amount Amount bridged to L2.
     * @param l2TxGasLimit L2 gas limit used for the bridge request.
     * @param l2TxGasPerPubdataByte L2 pubdata gas setting used for the bridge request.
     * @param refundRecipient L2 refund recipient configured on the request.
     * @param bridgeTxHash L2 transaction hash returned by BridgeHub.
     * @param isNative True when the bridge path used native intent.
     * @param emergency True when the bridge path used emergency semantics.
     */
    event BridgeSentToL2(
        address indexed token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address indexed refundRecipient,
        bytes32 bridgeTxHash,
        bool isNative,
        bool emergency
    );

    /**
     * @notice Shared bridge request parameters used across normal and emergency bridge flows.
     * @param bridgeHub L1 BridgeHub used to submit the request.
     * @param baseToken Mintable base token used to fund bridge base cost.
     * @param l2ChainId Target L2 chain id.
     * @param l2ExchangeRecipient L2 recipient for bridged funds and refunds.
     * @param wrappedNativeToken Canonical wrapped-native token for native-intent flows.
     * @param l2TxGasLimit L2 gas limit to request.
     * @param l2TxGasPerPubdataByte L2 pubdata gas setting to request.
     * @param token Vault token being bridged.
     * @param amount Requested bridge amount.
     * @param isNativeIntent True when the wrapped-native token should be unwrapped and bridged as native ETH.
     */
    struct BridgeRequest {
        address bridgeHub;
        address baseToken;
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
     * @notice Best-effort emergency unwind result for one strategy iteration.
     * @param strategy Strategy probed during the unwind loop.
     * @param request Amount requested from the strategy for this step.
     * @param reported Amount self-reported by the strategy call.
     * @param got Amount actually measured back at the vault.
     * @param skipped True when the step should be treated as non-fatal and ignored by the vault wrapper.
     */
    struct EmergencyUnwindStep {
        address strategy;
        uint256 request;
        uint256 reported;
        uint256 got;
        bool skipped;
    }

    /**
     * @notice Validates the standard bridge path against current idle balance and token support.
     * @dev Uses a defensive `balanceOf` probe so malformed/non-ERC20 tokens fail with `InvalidParam`.
     * @param request Shared bridge request parameters.
     * @param tokenSupported Whether the token is enabled for normal operations in the vault.
     */
    function ensureStandardBridgeOut(BridgeRequest memory request, bool tokenSupported) public view {
        _requireBridgeRequestConfigured(request);
        (bool ok, uint256 idle) = _tryBalanceOf(request.token, address(this));
        if (!ok || idle < request.amount) revert IL1TreasuryVault.InvalidParam();
        if (!tokenSupported) revert IL1TreasuryVault.TokenNotSupported();
    }

    /**
     * @notice Prepares an emergency bridge send and unwinds strategies if idle funds are insufficient.
     * @dev Reverts when the token cannot be defensively probed or when the requested amount remains unavailable
     *      after the bounded unwind loop completes.
     * @param request Shared bridge request parameters.
     * @param strategies Active strategy list for the token being unwound.
     * @return steps Per-strategy unwind results for the vault to finalize and emit.
     */
    function prepareEmergencyBridgeOut(
        BridgeRequest memory request,
        address[] memory strategies
    ) public returns (EmergencyUnwindStep[] memory steps) {
        _requireBridgeRequestConfigured(request);

        (bool ok, uint256 idle) = _tryBalanceOf(request.token, address(this));
        if (!ok) revert IL1TreasuryVault.InvalidParam();
        if (idle < request.amount) {
            (steps, ) = unwindStrategiesForEmergency(strategies, request.token, request.amount - idle);
        }
        (ok, idle) = _tryBalanceOf(request.token, address(this));
        if (!ok || idle < request.amount) revert IL1TreasuryVault.InvalidParam();
    }

    /**
     * @notice Executes the two-bridges L1 -> L2 request against BridgeHub.
     * @dev ERC20-only helper used by the vault's direct bridge path. Native-intent sends route through
     *      `NativeBridgeGateway` so failed deposits can be reclaimed without sending ETH back to the vault.
     * @param request Shared bridge request parameters.
     * @return txHash L2 transaction hash returned by BridgeHub.
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

        IGRVTBaseTokenMintable(request.baseToken).mint(address(this), baseCost);

        if (request.isNativeIntent || request.token == request.wrappedNativeToken) {
            revert IL1TreasuryVault.InvalidParam();
        }

        bool needsBaseApprove = request.token != request.baseToken;

        if (request.token == request.baseToken) {
            IERC20(request.token).forceApprove(sharedBridge, request.amount + baseCost);
        } else {
            IERC20(request.token).forceApprove(sharedBridge, request.amount);
        }
        if (needsBaseApprove) {
            IERC20(request.baseToken).forceApprove(sharedBridge, baseCost);
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
            IERC20(request.baseToken).forceApprove(sharedBridge, 0);
        }
    }

    /**
     * @notice Emits the unified bridge event for the completed request.
     * @param token Vault token bridged.
     * @param amount Bridge amount.
     * @param l2TxGasLimit L2 gas limit used for the request.
     * @param l2TxGasPerPubdataByte L2 pubdata gas setting used for the request.
     * @param refundRecipient L2 refund recipient configured on the request.
     * @param txHash L2 transaction hash returned by BridgeHub.
     * @param isNativeIntent True when the bridge path used native intent.
     * @param emergency True when the bridge path used emergency semantics.
     */
    function emitBridgeEvent(
        address token,
        uint256 amount,
        uint256 l2TxGasLimit,
        uint256 l2TxGasPerPubdataByte,
        address refundRecipient,
        bytes32 txHash,
        bool isNativeIntent,
        bool emergency
    ) public {
        emit BridgeSentToL2(
            token,
            amount,
            l2TxGasLimit,
            l2TxGasPerPubdataByte,
            refundRecipient,
            txHash,
            isNativeIntent,
            emergency
        );
    }

    /**
     * @notice Sends native ETH and normalizes failure to the vault's custom error surface.
     * @param recipient Native recipient.
     * @param amount Native amount to transfer.
     */
    function sendNative(address recipient, uint256 amount) public {
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert IL1TreasuryVault.NativeTransferFailed();
    }

    /**
     * @notice Attempts one best-effort emergency deallocation step and measures the received balance delta.
     * @param token Vault token being withdrawn.
     * @param strategy Strategy to call.
     * @param request Requested withdrawal amount.
     * @return reported Amount self-reported by the strategy.
     * @return got Amount actually measured back at the vault.
     * @return ok True when the step completed without revert and did not decrease vault balance.
     */
    function tryEmergencyDeallocate(
        address token,
        address strategy,
        uint256 request
    ) public returns (uint256 reported, uint256 got, bool ok) {
        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        try IYieldStrategy(strategy).deallocate(token, request) returns (uint256 received_) {
            reported = received_;
        } catch {
            return (0, 0, false);
        }
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal < beforeBal) return (reported, 0, false);
        got = afterBal - beforeBal;
        return (reported, got, true);
    }

    /**
     * @notice Iterates strategies to source emergency liquidity until the request is covered or exhausted.
     * @dev Failures are captured in `steps[i].skipped` instead of reverting so the vault wrapper can continue.
     * @param strategies Active strategies for the vault token.
     * @param token Vault token being unwound.
     * @param needed Remaining amount needed from strategies.
     * @return steps Per-strategy unwind results.
     * @return remainingNeeded Amount still uncovered after the bounded loop.
     */
    function unwindStrategiesForEmergency(
        address[] memory strategies,
        address token,
        uint256 needed
    ) public returns (EmergencyUnwindStep[] memory steps, uint256 remainingNeeded) {
        steps = new EmergencyUnwindStep[](strategies.length);
        remainingNeeded = needed;

        for (uint256 i = 0; i < strategies.length && remainingNeeded > 0; ++i) {
            address strategy = strategies[i];
            steps[i].strategy = strategy;

            (bool ok, uint256 exposure) = _readStrategyExposure(token, strategy);
            if (!ok || exposure == 0) {
                steps[i].skipped = !ok;
                continue;
            }

            uint256 request = remainingNeeded < exposure ? remainingNeeded : exposure;
            steps[i].request = request;

            (uint256 reported, uint256 got, bool deallocateOk) = tryEmergencyDeallocate(token, strategy, request);
            steps[i].reported = reported;
            steps[i].got = got;
            steps[i].skipped = !deallocateOk;
            if (!deallocateOk) continue;

            if (got >= remainingNeeded) {
                remainingNeeded = 0;
            } else {
                unchecked {
                    remainingNeeded -= got;
                }
            }
        }
    }

    /**
     * @notice Reads strategy exposure for emergency unwind planning.
     * @param token Vault token to query.
     * @param strategy Strategy to read.
     * @return ok True when the strategy call succeeded.
     * @return exposure Scalar exposure returned by the strategy when successful.
     */
    function _readStrategyExposure(address token, address strategy) private view returns (bool ok, uint256 exposure) {
        try IYieldStrategy(strategy).strategyExposure(token) returns (uint256 value) {
            return (true, value);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Validates that a bridge request contains the minimum non-zero wiring required for execution.
     * @param request Shared bridge request parameters to validate.
     */
    function _requireBridgeRequestConfigured(BridgeRequest memory request) private pure {
        if (
            request.amount == 0 ||
            request.bridgeHub == address(0) ||
            request.baseToken == address(0) ||
            request.l2ChainId == 0 ||
            request.l2ExchangeRecipient == address(0)
        ) {
            revert IL1TreasuryVault.InvalidParam();
        }
    }

    /**
     * @notice Performs a defensive ERC20 `balanceOf` probe for bridge readiness checks.
     * @param token Token contract to probe.
     * @param account Account whose balance should be read.
     * @return ok True when the token returned at least one full word of data.
     * @return balance Decoded balance when `ok == true`.
     */
    function _tryBalanceOf(address token, address account) private view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (!success || data.length < 32) {
            return (false, 0);
        }
        return (true, abi.decode(data, (uint256)));
    }
}
