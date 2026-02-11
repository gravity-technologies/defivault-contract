// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBridgehub, L2TransactionRequestTwoBridgesOuter} from "../external/IBridgehub.sol";

contract MockBridgehub is IBridgehub {
    address public immutable baseToken;
    uint256 public requestCount;

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

        // Simulate bridge custody pull from sender using allowance granted to `sharedBridge` (this contract).
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (request.mintValue != 0) {
            IERC20(baseToken).transferFrom(msg.sender, address(this), request.mintValue);
        }

        unchecked {
            ++requestCount;
        }

        canonicalTxHash = keccak256(abi.encode(requestCount, token, amount, request.refundRecipient));
    }
}
