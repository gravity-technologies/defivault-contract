// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IL1SharedBridge} from "../interfaces/IL1SharedBridge.sol";
import {IL1AssetRouter} from "../external/IL1AssetRouter.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";
import {ZkSyncAssetRouterEncoding} from "../external/ZkSyncAssetRouterEncoding.sol";

interface IMockBridgehubClaimRouter {
    function claimFailedDepositFromSharedBridge(
        uint256 chainId,
        address depositSender,
        address l1Token,
        uint256 amount,
        bytes32 l2TxHash,
        uint256 l2BatchNumber,
        uint256 l2MessageIndex,
        uint16 l2TxNumberInBatch,
        bytes32[] calldata merkleProof
    ) external;
}

contract MockNativeTokenVault {
    error Unauthorized();
    error NativeClaimFailed();

    address public immutable sharedBridge;

    constructor(address sharedBridge_) {
        sharedBridge = sharedBridge_;
    }

    function forwardClaim(address recipient) external payable {
        if (msg.sender != sharedBridge) revert Unauthorized();

        (bool ok, ) = recipient.call{value: msg.value}("");
        if (!ok) revert NativeClaimFailed();
    }
}

contract MockSharedBridge is IL1SharedBridge, IL1AssetRouter {
    using SafeERC20 for IERC20;

    address public immutable bridgeHub;
    address private _nativeTokenVault;

    constructor(address bridgeHub_) {
        bridgeHub = bridgeHub_;
        _nativeTokenVault = address(new MockNativeTokenVault(address(this)));
    }

    function nativeTokenVault() external view returns (address) {
        return _nativeTokenVault;
    }

    function rotateNativeTokenVault() external returns (address newNativeTokenVault) {
        newNativeTokenVault = address(new MockNativeTokenVault(address(this)));
        _nativeTokenVault = newNativeTokenVault;
    }

    function pullToken(address token, address from, address recipient, uint256 amount) external {
        require(msg.sender == bridgeHub, "UNAUTHORIZED_PULL");
        IERC20(token).safeTransferFrom(from, recipient, amount);
    }

    function forwardNativeClaim(address refundSender, address recipient) external payable {
        require(msg.sender == bridgeHub, "UNAUTHORIZED_FORWARD");
        MockNativeTokenVault(payable(refundSender)).forwardClaim{value: msg.value}(recipient);
    }

    function claimFailedDeposit(
        uint256 chainId,
        address depositSender,
        address l1Token,
        uint256 amount,
        bytes32 l2TxHash,
        uint256 l2BatchNumber,
        uint256 l2MessageIndex,
        uint16 l2TxNumberInBatch,
        bytes32[] calldata merkleProof
    ) external {
        IMockBridgehubClaimRouter(bridgeHub).claimFailedDepositFromSharedBridge(
            chainId,
            depositSender,
            l1Token,
            amount,
            l2TxHash,
            l2BatchNumber,
            l2MessageIndex,
            l2TxNumberInBatch,
            merkleProof
        );
    }
}

contract MockBridgehub is IL1ZkSyncBridgeHub, IL1SharedBridge, IL1AssetRouter, IMockBridgehubClaimRouter {
    using SafeERC20 for IERC20;

    struct PendingDeposit {
        address depositSender;
        address l1Token;
        uint256 amount;
        uint256 chainId;
        address sharedBridge;
        address refundSender;
        bool claimed;
    }

    address public immutable grvtBridgeProxyFeeToken;
    uint256 public requestCount;
    address public lastToken;
    uint256 public lastAmount;
    uint256 public lastSecondBridgeValue;
    uint256 public lastMsgValue;
    address public lastRefundRecipient;
    address public lastDepositSender;
    bytes32 public lastTxHash;
    bytes32 public lastClaimedTxHash;

    mapping(bytes32 txHash => PendingDeposit deposit) public pendingDeposits;

    address private _sharedBridge;

    constructor(address grvtBridgeProxyFeeToken_) {
        grvtBridgeProxyFeeToken = grvtBridgeProxyFeeToken_;
        _sharedBridge = address(new MockSharedBridge(address(this)));
    }

    function sharedBridge() external view override returns (address) {
        return _sharedBridge;
    }

    function nativeTokenAddress() external pure returns (address) {
        return ZkSyncAssetRouterEncoding.nativeTokenAddress();
    }

    function nativeTokenVault() external view returns (address) {
        return MockSharedBridge(_sharedBridge).nativeTokenVault();
    }

    function rotateNativeTokenVault() external returns (address newNativeTokenVault) {
        newNativeTokenVault = MockSharedBridge(_sharedBridge).rotateNativeTokenVault();
    }

    function rotateSharedBridge() external returns (address newSharedBridge) {
        newSharedBridge = address(new MockSharedBridge(address(this)));
        _sharedBridge = newSharedBridge;
    }

    function l2TransactionBaseCost(uint256, uint256, uint256, uint256) external pure override returns (uint256) {
        return 1;
    }

    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata request
    ) external payable override returns (bytes32 canonicalTxHash) {
        address requestSharedBridge = request.secondBridgeAddress;
        (address token, uint256 amount, ) = abi.decode(request.secondBridgeCalldata, (address, uint256, address));
        lastToken = token;
        lastAmount = amount;
        lastSecondBridgeValue = request.secondBridgeValue;
        lastMsgValue = msg.value;
        lastRefundRecipient = request.refundRecipient;
        lastDepositSender = msg.sender;

        if (ZkSyncAssetRouterEncoding.isNativeToken(token)) {
            require(request.secondBridgeValue == amount, "BAD_NATIVE_SECOND_BRIDGE_VALUE");
            require(msg.value == amount, "BAD_NATIVE_MSG_VALUE");
        } else {
            // Simulate bridge custody pull from sender using allowance granted to the shared bridge.
            MockSharedBridge(requestSharedBridge).pullToken(token, msg.sender, address(this), amount);
            require(request.secondBridgeValue == 0, "BAD_ERC20_SECOND_BRIDGE_VALUE");
            require(msg.value == 0, "BAD_ERC20_MSG_VALUE");
        }
        if (request.mintValue != 0) {
            MockSharedBridge(requestSharedBridge).pullToken(
                grvtBridgeProxyFeeToken,
                msg.sender,
                address(this),
                request.mintValue
            );
        }

        unchecked {
            ++requestCount;
        }

        canonicalTxHash = keccak256(abi.encode(requestCount, token, amount, request.refundRecipient));
        lastTxHash = canonicalTxHash;
        pendingDeposits[canonicalTxHash] = PendingDeposit({
            depositSender: msg.sender,
            l1Token: token,
            amount: amount,
            chainId: request.chainId,
            sharedBridge: requestSharedBridge,
            refundSender: MockSharedBridge(requestSharedBridge).nativeTokenVault(),
            claimed: false
        });
    }

    function claimFailedDeposit(
        uint256 chainId,
        address depositSender,
        address l1Token,
        uint256 amount,
        bytes32 l2TxHash,
        uint256,
        uint256,
        uint16,
        bytes32[] calldata
    ) external {
        MockSharedBridge(_sharedBridge).claimFailedDeposit(
            chainId,
            depositSender,
            l1Token,
            amount,
            l2TxHash,
            0,
            0,
            0,
            new bytes32[](0)
        );
    }

    function claimFailedDepositFromSharedBridge(
        uint256 chainId,
        address depositSender,
        address l1Token,
        uint256 amount,
        bytes32 l2TxHash,
        uint256,
        uint256,
        uint16,
        bytes32[] calldata
    ) external {
        PendingDeposit storage deposit = pendingDeposits[l2TxHash];
        require(deposit.amount != 0, "UNKNOWN_DEPOSIT");
        require(!deposit.claimed, "DEPOSIT_ALREADY_CLAIMED");
        require(deposit.chainId == chainId, "BAD_CHAIN_ID");
        require(deposit.depositSender == depositSender, "BAD_DEPOSIT_SENDER");
        require(deposit.l1Token == l1Token, "BAD_L1_TOKEN");
        require(deposit.amount == amount, "BAD_AMOUNT");
        require(deposit.sharedBridge == msg.sender, "BAD_SHARED_BRIDGE");

        deposit.claimed = true;
        lastClaimedTxHash = l2TxHash;

        if (ZkSyncAssetRouterEncoding.isNativeToken(l1Token)) {
            MockSharedBridge(payable(deposit.sharedBridge)).forwardNativeClaim{value: amount}(
                deposit.refundSender,
                depositSender
            );
            return;
        }

        IERC20(l1Token).safeTransfer(depositSender, amount);
    }
}
