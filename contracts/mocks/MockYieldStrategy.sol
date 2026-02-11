// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

/**
 * @dev Baseline yield strategy mock with internal tracked balances.
 * Models simple allocate/deallocate behavior for vault policy and accounting tests.
 * Includes optional testing knobs to force assets() reverts/overflow-like values.
 */
contract MockYieldStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();

    address public immutable vault;
    string private _name;
    mapping(address token => uint256 amount) private _trackedAssets;
    mapping(address token => bool value) public revertAssets;
    mapping(address token => bool value) public maxAssets;

    constructor(address vault_, string memory strategyName_) {
        if (vault_ == address(0) || bytes(strategyName_).length == 0) revert InvalidParam();
        vault = vault_;
        _name = strategyName_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function setAssets(address token, uint256 amount) external {
        _trackedAssets[token] = amount;
    }

    function setRevertAssets(address token, bool value) external {
        revertAssets[token] = value;
    }

    function setMaxAssets(address token, bool value) external {
        maxAssets[token] = value;
    }

    function assets(address token) external view returns (uint256) {
        if (revertAssets[token]) revert("ASSETS_REVERT");
        if (maxAssets[token]) return type(uint256).max;
        return _trackedAssets[token];
    }

    function allocate(address token, uint256 amount) external onlyVault {
        if (token == address(0) || amount == 0) revert InvalidParam();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(vault, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - beforeBal;
        _trackedAssets[token] += received;
    }

    function deallocate(address token, uint256 amount) external onlyVault returns (uint256 received) {
        if (token == address(0) || amount == 0) revert InvalidParam();

        uint256 tracked = _trackedAssets[token];
        uint256 sendAmount = amount < tracked ? amount : tracked;

        uint256 beforeBal = IERC20(token).balanceOf(vault);
        IERC20(token).safeTransfer(vault, sendAmount);
        received = IERC20(token).balanceOf(vault) - beforeBal;

        _trackedAssets[token] = tracked - sendAmount;
    }

    function deallocateAll(address token) external onlyVault returns (uint256 received) {
        uint256 tracked = _trackedAssets[token];
        if (tracked == 0) return 0;

        uint256 beforeBal = IERC20(token).balanceOf(vault);
        IERC20(token).safeTransfer(vault, tracked);
        received = IERC20(token).balanceOf(vault) - beforeBal;
        _trackedAssets[token] = 0;
    }
}
