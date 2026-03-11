// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {StrategyAssetBreakdown} from "../interfaces/IVaultReportingTypes.sol";

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

    function exactTokenBalance(address) external pure returns (uint256 exposure) {
        return exposure;
    }

    function positionBreakdown(address) external pure returns (StrategyAssetBreakdown memory breakdown) {
        return breakdown;
    }

    function principalBearingExposure(address) external pure returns (uint256 exposure) {
        return 0;
    }

    function allocate(address token_, uint256) external onlyVault {
        if (token_ != token) revert InvalidParam();
        if (triggerReenter) {
            IL1TreasuryVault(vault).allocatePrincipalToStrategy(token, address(this), 1);
        }
    }

    function deallocate(address, uint256) external pure returns (uint256 received) {
        received = 0;
    }

    function deallocateAll(address) external pure returns (uint256 received) {
        received = 0;
    }
}
