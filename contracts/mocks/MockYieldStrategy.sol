// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

/**
 * @title MockYieldStrategy
 * @notice Test-only yield strategy mock with configurable reporting and balances.
 * @dev Models vault-only allocate/deallocate flows and allows tests to force report reverts,
 *      overflow-like values, and custom token-component payloads.
 */
contract MockYieldStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;
    uint16 private constant BPS_SCALE = 10_000;

    struct MockComponent {
        address token;
        uint256 amount;
    }

    error Unauthorized();
    error InvalidParam();

    address public immutable vault;
    string private _name;

    mapping(address token => uint256 amount) private _trackedAssets;
    mapping(address token => bool value) public revertAssets;
    mapping(address token => bool value) public maxAssets;
    mapping(address token => bool value) public exposureOverrideSet;
    mapping(address token => uint256 value) public exposureOverride;
    mapping(address token => bool value) public allocatePullBpsSet;
    mapping(address token => uint16 value) public allocatePullBps;
    mapping(address token => bool value) public allocatePullAmountOverrideSet;
    mapping(address token => uint256 value) public allocatePullAmountOverride;
    mapping(address token => uint256 value) public allocateRefundToVault;
    mapping(address vaultToken => MockComponent[] components) private _mockedComponents;

    constructor(address vault_, string memory strategyName_) {
        if (vault_ == address(0) || bytes(strategyName_).length == 0) revert InvalidParam();
        vault = vault_;
        _name = strategyName_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    /// @inheritdoc IYieldStrategy
    function name() external view override returns (string memory) {
        return _name;
    }

    /// @notice Sets exact-token balance, default exposure value, and default single-token breakdown for `token`.
    function setAssets(address token, uint256 amount) external {
        delete _mockedComponents[token];
        _trackedAssets[token] = amount;
    }

    /// @notice Sets explicit position breakdown payload returned by `positionBreakdown(vaultToken)`.
    function setComponents(address vaultToken, address[] calldata tokens, uint256[] calldata amounts) external {
        if (tokens.length != amounts.length) revert InvalidParam();
        delete _mockedComponents[vaultToken];

        uint256 exactAccountingBalance;
        for (uint256 i = 0; i < tokens.length; ++i) {
            _mockedComponents[vaultToken].push(MockComponent({token: tokens[i], amount: amounts[i]}));
            if (tokens[i] == vaultToken) exactAccountingBalance += amounts[i];
        }
        _trackedAssets[vaultToken] = exactAccountingBalance;
    }

    /// @notice Configures exact-token, breakdown, and exposure reads for `token` to revert in tests.
    function setRevertAssets(address token, bool value) external {
        revertAssets[token] = value;
    }

    /// @notice Configures mock to report `type(uint256).max` exposure/component for `token`.
    function setMaxAssets(address token, bool value) external {
        maxAssets[token] = value;
    }

    /// @notice Overrides the exposure value returned by `strategyExposure(token)`.
    function setExposure(address token, uint256 exposure) external {
        exposureOverrideSet[token] = true;
        exposureOverride[token] = exposure;
    }

    /// @notice Clears the exposure override for `token`.
    function clearExposure(address token) external {
        delete exposureOverrideSet[token];
        delete exposureOverride[token];
    }

    /// @notice Sets allocation pull fraction for `token` in basis points.
    function setAllocatePullBps(address token, uint16 bps) external {
        if (bps > BPS_SCALE) revert InvalidParam();
        allocatePullBpsSet[token] = true;
        allocatePullBps[token] = bps;
    }

    /// @notice Clears allocation pull fraction override for `token`.
    function clearAllocatePullBps(address token) external {
        delete allocatePullBpsSet[token];
        delete allocatePullBps[token];
    }

    /// @notice Sets exact allocation pull amount override for `token`.
    function setAllocatePullAmount(address token, uint256 amount) external {
        allocatePullAmountOverrideSet[token] = true;
        allocatePullAmountOverride[token] = amount;
    }

    /// @notice Clears exact allocation pull amount override for `token`.
    function clearAllocatePullAmount(address token) external {
        delete allocatePullAmountOverrideSet[token];
        delete allocatePullAmountOverride[token];
    }

    /// @notice Sets same-call refund amount sent back to vault during `allocate`.
    function setAllocateRefundToVault(address token, uint256 amount) external {
        allocateRefundToVault[token] = amount;
    }

    /// @inheritdoc IYieldStrategy
    function exactTokenBalance(address token) external view override returns (uint256) {
        if (revertAssets[token]) revert("ASSETS_REVERT");
        uint256 amount = maxAssets[token] ? type(uint256).max : _trackedAssets[token];
        return amount;
    }

    /// @inheritdoc IYieldStrategy
    function tvlTokens(address vaultToken) external view override returns (address[] memory tokens) {
        MockComponent[] storage mocked = _mockedComponents[vaultToken];
        if (mocked.length != 0) {
            tokens = new address[](mocked.length);
            for (uint256 i = 0; i < mocked.length; ++i) {
                tokens[i] = mocked[i].token;
            }
            return tokens;
        }
        tokens = new address[](1);
        tokens[0] = vaultToken;
    }

    /// @inheritdoc IYieldStrategy
    function positionBreakdown(address token) external view override returns (PositionComponent[] memory components) {
        if (revertAssets[token]) revert("ASSETS_REVERT");

        MockComponent[] storage mocked = _mockedComponents[token];
        if (mocked.length != 0) {
            components = new PositionComponent[](mocked.length);
            for (uint256 i = 0; i < mocked.length; ++i) {
                components[i] = PositionComponent({
                    token: mocked[i].token,
                    amount: mocked[i].amount,
                    kind: PositionComponentKind.InvestedPosition
                });
            }
            return components;
        }

        uint256 amount = maxAssets[token] ? type(uint256).max : _trackedAssets[token];
        if (amount == 0) return components;

        components = new PositionComponent[](1);
        components[0] = PositionComponent({token: token, amount: amount, kind: PositionComponentKind.InvestedPosition});
    }

    /// @inheritdoc IYieldStrategy
    function strategyExposure(address token) external view override returns (uint256 exposure) {
        if (revertAssets[token]) revert("EXPOSURE_REVERT");
        if (maxAssets[token]) return type(uint256).max;
        if (exposureOverrideSet[token]) return exposureOverride[token];
        return _trackedAssets[token];
    }

    /// @inheritdoc IYieldStrategy
    function allocate(address token, uint256 amount) external override onlyVault {
        if (token == address(0) || amount == 0) revert InvalidParam();

        uint256 pullAmount = amount;
        if (allocatePullAmountOverrideSet[token]) {
            pullAmount = allocatePullAmountOverride[token];
        } else if (allocatePullBpsSet[token]) {
            pullAmount = (amount * allocatePullBps[token]) / BPS_SCALE;
        }
        if (pullAmount > amount) revert InvalidParam();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        if (pullAmount != 0) {
            IERC20(token).safeTransferFrom(vault, address(this), pullAmount);
        }
        uint256 afterPull = IERC20(token).balanceOf(address(this));
        if (afterPull < beforeBal) revert InvalidParam();

        uint256 refund = allocateRefundToVault[token];
        if (refund != 0) {
            uint256 refundBefore = afterPull;
            IERC20(token).safeTransfer(vault, refund);
            uint256 refundAfter = IERC20(token).balanceOf(address(this));
            if (refundAfter > refundBefore) revert InvalidParam();
            _trackedAssets[token] = refundAfter;
            return;
        }

        _trackedAssets[token] = afterPull;
    }

    /// @inheritdoc IYieldStrategy
    function deallocate(address token, uint256 amount) external override onlyVault returns (uint256 received) {
        if (token == address(0) || amount == 0) revert InvalidParam();

        uint256 tracked = _trackedAssets[token];
        uint256 sendAmount = amount < tracked ? amount : tracked;

        uint256 beforeBal = IERC20(token).balanceOf(vault);
        IERC20(token).safeTransfer(vault, sendAmount);
        received = IERC20(token).balanceOf(vault) - beforeBal;

        _trackedAssets[token] = tracked - sendAmount;
    }

    /// @inheritdoc IYieldStrategy
    function deallocateAll(address token) external override onlyVault returns (uint256 received) {
        if (token == address(0)) revert InvalidParam();

        uint256 tracked = _trackedAssets[token];
        if (tracked == 0) return 0;

        uint256 beforeBal = IERC20(token).balanceOf(vault);
        IERC20(token).safeTransfer(vault, tracked);
        received = IERC20(token).balanceOf(vault) - beforeBal;
        _trackedAssets[token] = 0;
    }
}
