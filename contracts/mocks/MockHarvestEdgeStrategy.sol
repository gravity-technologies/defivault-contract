// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {PositionComponent, PositionComponentKind} from "../interfaces/IVaultReportingTypes.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockHarvestEdgeStrategy
 * @notice Test-only strategy mock for harvest edge-case coverage.
 * @dev Supports configurable deallocate bonus and exposure overrides to exercise
 *      vault guard rails around yield accounting.
 */
contract MockHarvestEdgeStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();

    address public immutable vault;

    mapping(address token => uint256 amount) private _trackedAssets;
    mapping(address token => bool enabled) public exposureOverrideSet;
    mapping(address token => uint256 value) public exposureOverride;
    mapping(address token => uint256 value) public deallocateBonus;

    constructor(address vault_) {
        if (vault_ == address(0)) revert InvalidParam();
        vault = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    function name() external pure override returns (string memory) {
        return "HARVEST_EDGE";
    }

    function setAssets(address token, uint256 amount) external {
        _trackedAssets[token] = amount;
    }

    function setExposure(address token, uint256 exposure) external {
        exposureOverrideSet[token] = true;
        exposureOverride[token] = exposure;
    }

    function clearExposure(address token) external {
        delete exposureOverrideSet[token];
        delete exposureOverride[token];
    }

    function setDeallocateBonus(address token, uint256 bonus) external {
        deallocateBonus[token] = bonus;
    }

    function exactTokenBalance(address token) external view override returns (uint256) {
        return _trackedAssets[token];
    }

    function tvlTokens(address vaultToken) external pure override returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = vaultToken;
    }

    function positionBreakdown(address token) external view override returns (PositionComponent[] memory components) {
        uint256 tracked = _trackedAssets[token];
        if (tracked == 0) return components;

        components = new PositionComponent[](1);
        components[0] = PositionComponent({
            token: token,
            amount: tracked,
            kind: PositionComponentKind.InvestedPosition
        });
    }

    function strategyExposure(address token) external view override returns (uint256 exposure) {
        if (exposureOverrideSet[token]) return exposureOverride[token];
        return _trackedAssets[token];
    }

    function allocate(address token, uint256 amount) external override onlyVault {
        if (token == address(0) || amount == 0) revert InvalidParam();
        IERC20(token).safeTransferFrom(vault, address(this), amount);
        _trackedAssets[token] += amount;
        if (exposureOverrideSet[token]) exposureOverride[token] += amount;
    }

    function deallocate(address token, uint256 amount) external override onlyVault returns (uint256 received) {
        if (token == address(0) || amount == 0) revert InvalidParam();
        return _deallocateInternal(token, amount);
    }

    function deallocateAll(address token) external override onlyVault returns (uint256 received) {
        if (token == address(0)) revert InvalidParam();
        return _deallocateInternal(token, type(uint256).max);
    }

    function _deallocateInternal(address token, uint256 requested) internal returns (uint256 received) {
        uint256 tracked = _trackedAssets[token];
        uint256 sendAmount = requested < tracked ? requested : tracked;

        uint256 beforeVault = IERC20(token).balanceOf(vault);
        if (sendAmount != 0) {
            IERC20(token).safeTransfer(vault, sendAmount);
            _trackedAssets[token] = tracked - sendAmount;
        }

        uint256 bonus = deallocateBonus[token];
        if (bonus != 0) IMintableERC20(token).mint(vault, bonus);

        uint256 afterVault = IERC20(token).balanceOf(vault);
        received = afterVault - beforeVault;
        if (exposureOverrideSet[token]) {
            uint256 current = exposureOverride[token];
            exposureOverride[token] = current > received ? current - received : 0;
        }
    }
}
