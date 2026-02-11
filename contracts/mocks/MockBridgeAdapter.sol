// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IExchangeBridgeAdapter} from "../interfaces/IExchangeBridgeAdapter.sol";

contract MockBridgeAdapter is IExchangeBridgeAdapter {
    using SafeERC20 for IERC20;

    address public lastToken;
    uint256 public lastAmount;
    address public lastRecipient;
    bytes public lastData;
    uint256 public sendCount;
    mapping(address caller => bool trusted) private _trustedInbound;

    function sendToL2(address token, uint256 amount, address l2Recipient, bytes calldata data) external {
        IERC20(token).safeTransferFrom(msg.sender, l2Recipient, amount);
        lastToken = token;
        lastAmount = amount;
        lastRecipient = l2Recipient;
        lastData = data;
        sendCount += 1;
    }

    function isTrustedInboundCaller(address caller) external view returns (bool) {
        return _trustedInbound[caller];
    }

    function setTrustedInboundCaller(address caller, bool trusted) external {
        _trustedInbound[caller] = trusted;
    }
}
