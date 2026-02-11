// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IL1ZkSyncBridgeHub, L2TransactionRequestTwoBridgesOuter} from "../external/IL1ZkSyncBridgeHub.sol";

contract MockBridgehub is IL1ZkSyncBridgeHub {
    address public immutable baseToken;
    uint256 public requestCount;
    address public lastToken;
    uint256 public lastAmount;
    uint256 public lastSecondBridgeValue;
    uint256 public lastMsgValue;

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
    }
}
