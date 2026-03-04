// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IL1DefiVault} from "../interfaces/IL1DefiVault.sol";
import {StrategyAssetBreakdown, VaultTokenStatus, VaultTokenTotals} from "../interfaces/IVaultReportingTypes.sol";

contract GRVTDeFiVault is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, IL1DefiVault {
    bytes32 public constant override VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant override REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant override ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant override PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address bridgeHub_,
        address baseToken_,
        uint256 l2ChainId_,
        address l2ExchangeRecipient_,
        address wrappedNativeToken_
    ) external initializer {
        if (
            admin == address(0) ||
            bridgeHub_ == address(0) ||
            baseToken_ == address(0) ||
            l2ChainId_ == 0 ||
            l2ExchangeRecipient_ == address(0) ||
            wrappedNativeToken_ == address(0)
        ) {
            revert InvalidParam();
        }

        __AccessControl_init();
        __ReentrancyGuard_init();

        _setRoleAdmin(VAULT_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(REBALANCER_ROLE, VAULT_ADMIN_ROLE);
        _setRoleAdmin(ALLOCATOR_ROLE, VAULT_ADMIN_ROLE);
        _setRoleAdmin(PAUSER_ROLE, VAULT_ADMIN_ROLE);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function hasRole(
        bytes32 role,
        address account
    ) public view override(AccessControlUpgradeable, IL1DefiVault) returns (bool) {
        return super.hasRole(role, account);
    }

    function bridgeHub() external pure override returns (address) {
        return address(0);
    }

    function baseToken() external pure override returns (address) {
        return address(0);
    }

    function l2ChainId() external pure override returns (uint256) {
        return 0;
    }

    function l2ExchangeRecipient() external pure override returns (address) {
        return address(0);
    }

    function wrappedNativeToken() external pure override returns (address) {
        return address(0);
    }

    function paused() external pure override returns (bool) {
        return false;
    }

    function pause() external pure override {
        revert InvalidParam();
    }

    function unpause() external pure override {
        revert InvalidParam();
    }

    function getTokenConfig(address) external pure override returns (TokenConfig memory cfg) {
        return cfg;
    }

    function setTokenConfig(address, TokenConfig calldata) external pure override {
        revert InvalidParam();
    }

    function isStrategyWhitelisted(address, address) external pure override returns (bool) {
        return false;
    }

    function getStrategyConfig(address, address) external pure override returns (StrategyConfig memory cfg) {
        return cfg;
    }

    function getTokenStrategies(address) external pure override returns (address[] memory strategies) {
        return strategies;
    }

    function whitelistStrategy(address, address, StrategyConfig calldata) external pure override {
        revert InvalidParam();
    }

    function idleAssets(address) public pure override returns (uint256) {
        return 0;
    }

    function strategyAssets(address, address) public pure override returns (StrategyAssetBreakdown memory breakdown) {
        return breakdown;
    }

    function totalAssets(address) public pure override returns (VaultTokenTotals memory totals) {
        return totals;
    }

    function totalAssetsStatus(address) external pure override returns (VaultTokenStatus memory status) {
        return status;
    }

    function getTrackedTokens() external pure override returns (address[] memory tokens) {
        return tokens;
    }

    function isTrackedToken(address) external pure override returns (bool) {
        return false;
    }

    function totalAssetsBatch(
        address[] calldata tokens
    ) external pure override returns (VaultTokenStatus[] memory statuses) {
        statuses = new VaultTokenStatus[](tokens.length);
    }

    function availableForRebalance(address) public pure override returns (uint256) {
        return 0;
    }

    function allocateToStrategy(address, address, uint256) external pure override {
        revert InvalidParam();
    }

    function deallocateFromStrategy(address, address, uint256) external pure override returns (uint256 received) {
        revert InvalidParam();
    }

    function deallocateAllFromStrategy(address, address) external pure override returns (uint256 received) {
        revert InvalidParam();
    }

    function rebalanceToL2(address, uint256) external payable override {
        revert InvalidParam();
    }

    function emergencySendToL2(address, uint256) external payable override {
        revert InvalidParam();
    }

    function sweepNative(uint256) external pure override {
        revert InvalidParam();
    }

    receive() external payable {
        revert InvalidParam();
    }

    fallback() external payable {
        revert InvalidParam();
    }
}
