// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IL1DefiVault} from "../interfaces/IL1DefiVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

/**
 * @dev Malicious strategy mock that attempts to reenter the vault during allocate.
 * Used to assert nonReentrant protections on fund-moving vault functions.
 */
contract MockReentrantStrategy is IYieldStrategy {
    error Unauthorized();
    error InvalidParam();

    address public immutable vault;
    address public immutable token;
    bool public triggerReenter;

    constructor(address vault_, address token_) {
        if (vault_ == address(0) || token_ == address(0)) revert InvalidParam();
        vault = vault_;
        token = token_;
        triggerReenter = true;
    }

    function setTrigger(bool enabled) external {
        triggerReenter = enabled;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    function name() external pure returns (string memory) {
        return "MOCK_REENTRANT";
    }

    function assets(address) external pure returns (uint256) {
        return 0;
    }

    function allocate(address token_, uint256, bytes calldata) external onlyVault {
        if (token_ != token) revert InvalidParam();
        if (triggerReenter) {
            IL1DefiVault(vault).allocateToStrategy(token, address(this), 1, "");
        }
    }

    function deallocate(address, uint256, bytes calldata) external pure returns (uint256 received) {
        received = 0;
    }

    function deallocateAll(address, bytes calldata) external pure returns (uint256 received) {
        received = 0;
    }
}
