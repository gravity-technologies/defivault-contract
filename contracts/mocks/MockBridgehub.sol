// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";

contract MockBridgehub is IL1ZkSyncBridgeHub {
    using SafeERC20 for IERC20;

    struct PendingDeposit {
        address depositSender;
        address l1Token;
        uint256 amount;
        uint256 chainId;
        bool claimed;
    }

    address public immutable baseToken;
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

    address private immutable _sharedBridge;

    constructor(address baseToken_) {
        baseToken = baseToken_;
        _sharedBridge = address(this);
    }

    function sharedBridge() external view override returns (address) {
        return _sharedBridge;
    }

    function l2TransactionBaseCost(uint256, uint256, uint256, uint256) external pure override returns (uint256) {
        return 1;
    }

    function requestL2TransactionTwoBridges(
        L2TransactionRequestTwoBridgesOuter calldata request
    ) external payable override returns (bytes32 canonicalTxHash) {
        (address token, uint256 amount, ) = abi.decode(request.secondBridgeCalldata, (address, uint256, address));
        lastToken = token;
        lastAmount = amount;
        lastSecondBridgeValue = request.secondBridgeValue;
        lastMsgValue = msg.value;
        lastRefundRecipient = request.refundRecipient;
        lastDepositSender = msg.sender;

        if (token == address(0)) {
            require(request.secondBridgeValue == amount, "BAD_NATIVE_SECOND_BRIDGE_VALUE");
            require(msg.value == amount, "BAD_NATIVE_MSG_VALUE");
        } else {
            // Simulate bridge custody pull from sender using allowance granted to `sharedBridge` (this contract).
            IERC20(token).transferFrom(msg.sender, address(this), amount);
            require(request.secondBridgeValue == 0, "BAD_ERC20_SECOND_BRIDGE_VALUE");
            require(msg.value == 0, "BAD_ERC20_MSG_VALUE");
        }
        if (request.mintValue != 0) {
            IERC20(baseToken).transferFrom(msg.sender, address(this), request.mintValue);
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
        PendingDeposit storage deposit = pendingDeposits[l2TxHash];
        require(deposit.amount != 0, "UNKNOWN_DEPOSIT");
        require(!deposit.claimed, "DEPOSIT_ALREADY_CLAIMED");
        require(deposit.chainId == chainId, "BAD_CHAIN_ID");
        require(deposit.depositSender == depositSender, "BAD_DEPOSIT_SENDER");
        require(deposit.l1Token == l1Token, "BAD_L1_TOKEN");
        require(deposit.amount == amount, "BAD_AMOUNT");

        deposit.claimed = true;
        lastClaimedTxHash = l2TxHash;

        if (l1Token == address(0)) {
            (bool ok, ) = depositSender.call{value: amount}("");
            require(ok, "NATIVE_CLAIM_FAILED");
            return;
        }

        IERC20(l1Token).safeTransfer(depositSender, amount);
    }
}
