// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {
    TokenAmountComponent,
    TokenAmountComponentKind,
    StrategyAssetBreakdown
} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @dev Strategy mock that can deliberately over-report deallocation return values.
 * Used to verify vault balance-delta accounting and mismatch telemetry events.
 */
contract MockOverreportingStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();

    address public immutable vault;
    uint256 public reportExtra;
    mapping(address token => uint256 amount) private _trackedAssets;

    constructor(address vault_) {
        if (vault_ == address(0)) revert InvalidParam();
        vault = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    function setReportExtra(uint256 extra) external {
        reportExtra = extra;
    }

    function setAssets(address token, uint256 amount) external {
        _trackedAssets[token] = amount;
    }

    function name() external pure returns (string memory) {
        return "OVERREPORTING_STRATEGY";
    }

    function assets(address token) external view returns (StrategyAssetBreakdown memory breakdown) {
        uint256 amount = _trackedAssets[token];
        if (amount == 0) return breakdown;

        breakdown.components = new TokenAmountComponent[](1);
        breakdown.components[0] = TokenAmountComponent({
            token: token,
            amount: amount,
            kind: TokenAmountComponentKind.InvestedPrincipal
        });
    }

    function principalBearingExposure(address token) external view returns (uint256 exposure) {
        return _trackedAssets[token];
    }

    function allocate(address token, uint256 amount) external onlyVault {
        if (token == address(0) || amount == 0) revert InvalidParam();

        IERC20(token).safeTransferFrom(vault, address(this), amount);
        _trackedAssets[token] += amount;
    }

    function deallocate(address token, uint256 amount) external onlyVault returns (uint256 received) {
        if (token == address(0) || amount == 0) revert InvalidParam();

        uint256 tracked = _trackedAssets[token];
        uint256 sendAmount = amount < tracked ? amount : tracked;
        if (sendAmount == 0) return reportExtra;

        IERC20(token).safeTransfer(vault, sendAmount);
        _trackedAssets[token] = tracked - sendAmount;
        return sendAmount + reportExtra;
    }

    function deallocateAll(address token) external onlyVault returns (uint256 received) {
        if (token == address(0)) revert InvalidParam();

        uint256 tracked = _trackedAssets[token];
        if (tracked == 0) return reportExtra;

        IERC20(token).safeTransfer(vault, tracked);
        _trackedAssets[token] = 0;
        return tracked + reportExtra;
    }
}
