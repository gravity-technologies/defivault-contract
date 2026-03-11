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
 * @title MockYieldStrategy
 * @notice Test-only yield strategy mock with configurable reporting and balances.
 * @dev Models vault-only allocate/deallocate flows and allows tests to force report reverts,
 *      overflow-like values, and custom token-component payloads.
 */
contract MockYieldStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;

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
    mapping(address principalToken => MockComponent[] components) private _mockedComponents;

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

    /// @notice Sets exact-token balance, scalar exposure default, and default single-token breakdown for `token`.
    function setAssets(address token, uint256 amount) external {
        delete _mockedComponents[token];
        _trackedAssets[token] = amount;
    }

    /// @notice Sets explicit principal-domain breakdown payload returned by `positionBreakdown(principalToken)`.
    function setComponents(address principalToken, address[] calldata tokens, uint256[] calldata amounts) external {
        if (tokens.length != amounts.length) revert InvalidParam();
        delete _mockedComponents[principalToken];

        uint256 exactPrincipalBalance;
        for (uint256 i = 0; i < tokens.length; ++i) {
            _mockedComponents[principalToken].push(MockComponent({token: tokens[i], amount: amounts[i]}));
            if (tokens[i] == principalToken) exactPrincipalBalance += amounts[i];
        }
        _trackedAssets[principalToken] = exactPrincipalBalance;
    }

    /// @notice Configures exact-token, breakdown, and exposure reads for `token` to revert in tests.
    function setRevertAssets(address token, bool value) external {
        revertAssets[token] = value;
    }

    /// @notice Configures mock to report `type(uint256).max` exposure/component for `token`.
    function setMaxAssets(address token, bool value) external {
        maxAssets[token] = value;
    }

    /// @notice Overrides scalar exposure returned by `principalBearingExposure(token)`.
    function setExposure(address token, uint256 exposure) external {
        exposureOverrideSet[token] = true;
        exposureOverride[token] = exposure;
    }

    /// @notice Clears scalar exposure override for `token`.
    function clearExposure(address token) external {
        delete exposureOverrideSet[token];
        delete exposureOverride[token];
    }

    /// @inheritdoc IYieldStrategy
    function exactTokenBalance(address token) external view override returns (uint256) {
        if (revertAssets[token]) revert("ASSETS_REVERT");
        uint256 amount = maxAssets[token] ? type(uint256).max : _trackedAssets[token];
        return amount;
    }

    /// @inheritdoc IYieldStrategy
    function positionBreakdown(address token) external view override returns (StrategyAssetBreakdown memory breakdown) {
        if (revertAssets[token]) revert("ASSETS_REVERT");

        MockComponent[] storage mocked = _mockedComponents[token];
        if (mocked.length != 0) {
            breakdown.components = new TokenAmountComponent[](mocked.length);
            for (uint256 i = 0; i < mocked.length; ++i) {
                breakdown.components[i] = TokenAmountComponent({
                    token: mocked[i].token,
                    amount: mocked[i].amount,
                    kind: TokenAmountComponentKind.InvestedPrincipal
                });
            }
            return breakdown;
        }

        uint256 amount = maxAssets[token] ? type(uint256).max : _trackedAssets[token];
        if (amount == 0) return breakdown;

        breakdown.components = new TokenAmountComponent[](1);
        breakdown.components[0] = TokenAmountComponent({
            token: token,
            amount: amount,
            kind: TokenAmountComponentKind.InvestedPrincipal
        });
    }

    /// @inheritdoc IYieldStrategy
    function principalBearingExposure(address token) external view override returns (uint256 exposure) {
        if (revertAssets[token]) revert("EXPOSURE_REVERT");
        if (maxAssets[token]) return type(uint256).max;
        if (exposureOverrideSet[token]) return exposureOverride[token];
        return _trackedAssets[token];
    }

    /// @inheritdoc IYieldStrategy
    function allocate(address token, uint256 amount) external override onlyVault {
        if (token == address(0) || amount == 0) revert InvalidParam();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(vault, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - beforeBal;
        _trackedAssets[token] += received;
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
