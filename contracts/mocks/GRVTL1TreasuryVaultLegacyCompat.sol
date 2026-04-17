// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

/**
 * @title GRVTL1TreasuryVaultLegacyCompat
 * @notice Test-only stand-in for the pre-module vault implementation.
 * @dev Keeps the historical app-storage layout so proxy upgrades into the current vault
 *      can be exercised against authentic legacy strategy flows without carrying the full
 *      historical implementation forever.
 */
contract GRVTL1TreasuryVaultLegacyCompat is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant MAX_STRATEGIES_PER_TOKEN = 8;

    address private _bridgeHub;
    address private _grvtBridgeProxyFeeToken;
    uint256 private _l2ChainId;
    address private _l2ExchangeRecipient;
    address private _wrappedNativeToken;
    address private _nativeBridgeGateway;
    address private _yieldRecipient;
    bool private _paused;
    mapping(address token => IL1TreasuryVault.VaultTokenConfig cfg) private _vaultTokenConfigs;
    mapping(address token => mapping(address strategy => uint256 costBasis)) private _strategyCostBasis;
    mapping(address token => mapping(address strategy => IL1TreasuryVault.VaultTokenStrategyConfig cfg))
        private _vaultTokenStrategyConfigs;
    mapping(address token => address[] strategies) private _vaultTokenStrategies;
    address[] private _activeStrategies;
    mapping(address strategy => uint256 refs) private _activeStrategyRefCount;
    address[] private _supportedVaultTokens;
    mapping(address token => bool supported) private _supportedVaultTokenSet;
    address[] private _trackedTvlTokens;
    mapping(address token => bool tracked) private _trackedTvlTokenSet;
    mapping(address token => uint256 refs) private _trackedTvlTokenRefCount;
    mapping(address token => bool trackedDirectly) private _vaultTokenDirectTvlTracked;
    mapping(address vaultToken => mapping(address strategy => address[] tokens)) private _cachedStrategyTvlTokens;
    mapping(address token => bool enabled) private _trackedTvlTokenOverrideEnabled;
    mapping(address token => bool forceTrack) private _trackedTvlTokenOverrideValue;
    address private _yieldRecipientTimelockController;
    mapping(address token => bool bridgeable) private _bridgeableVaultTokens;
    mapping(address token => mapping(address strategy => IL1TreasuryVault.StrategyPolicyConfig cfg))
        private _strategyPolicyConfigs;
    uint256[49] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address bridgeHub_,
        address grvtBridgeProxyFeeToken_,
        uint256 l2ChainId_,
        address l2ExchangeRecipient_,
        address wrappedNativeToken_,
        address yieldRecipient_
    ) external initializer {
        if (
            admin == address(0) ||
            bridgeHub_ == address(0) ||
            grvtBridgeProxyFeeToken_ == address(0) ||
            l2ChainId_ == 0 ||
            l2ExchangeRecipient_ == address(0) ||
            wrappedNativeToken_ == address(0) ||
            yieldRecipient_ == address(0) ||
            yieldRecipient_ == admin
        ) revert IL1TreasuryVault.InvalidParam();

        __AccessControl_init();
        __ReentrancyGuard_init();

        _setRoleAdmin(VAULT_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(REBALANCER_ROLE, VAULT_ADMIN_ROLE);
        _setRoleAdmin(ALLOCATOR_ROLE, VAULT_ADMIN_ROLE);
        _setRoleAdmin(PAUSER_ROLE, VAULT_ADMIN_ROLE);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        _bridgeHub = bridgeHub_;
        _grvtBridgeProxyFeeToken = grvtBridgeProxyFeeToken_;
        _l2ChainId = l2ChainId_;
        _l2ExchangeRecipient = l2ExchangeRecipient_;
        _wrappedNativeToken = wrappedNativeToken_;
        _yieldRecipient = yieldRecipient_;
    }

    function bridgeHub() external view returns (address) {
        return _bridgeHub;
    }

    function grvtBridgeProxyFeeToken() external view returns (address) {
        return _grvtBridgeProxyFeeToken;
    }

    function l2ChainId() external view returns (uint256) {
        return _l2ChainId;
    }

    function l2ExchangeRecipient() external view returns (address) {
        return _l2ExchangeRecipient;
    }

    function wrappedNativeToken() external view returns (address) {
        return _wrappedNativeToken;
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    function getVaultTokenConfig(address token) external view returns (IL1TreasuryVault.VaultTokenConfig memory) {
        if (token == address(0)) revert IL1TreasuryVault.InvalidParam();
        return _vaultTokenConfigs[token];
    }

    function getVaultTokenStrategyConfig(
        address token,
        address strategy
    ) external view returns (IL1TreasuryVault.VaultTokenStrategyConfig memory) {
        if (token == address(0) || strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        return _vaultTokenStrategyConfigs[token][strategy];
    }

    function getVaultTokenStrategies(address token) external view returns (address[] memory) {
        if (token == address(0)) revert IL1TreasuryVault.InvalidParam();
        return _vaultTokenStrategies[token];
    }

    function idleTokenBalance(address token) external view returns (uint256) {
        if (token == address(0)) revert IL1TreasuryVault.InvalidParam();
        return IERC20(token).balanceOf(address(this));
    }

    function strategyCostBasis(address token, address strategy) external view returns (uint256) {
        if (token == address(0) || strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        return _strategyCostBasis[token][strategy];
    }

    function setVaultTokenConfig(
        address token,
        IL1TreasuryVault.VaultTokenConfig calldata cfg
    ) external onlyVaultAdmin {
        if (token == address(0)) revert IL1TreasuryVault.InvalidParam();
        _vaultTokenConfigs[token] = cfg;
        if (cfg.supported && !_supportedVaultTokenSet[token]) {
            _supportedVaultTokenSet[token] = true;
            _supportedVaultTokens.push(token);
        }
    }

    function setBridgeableVaultToken(address token, bool bridgeable) external onlyVaultAdmin {
        if (token == address(0)) revert IL1TreasuryVault.InvalidParam();
        _bridgeableVaultTokens[token] = bridgeable;
    }

    function setVaultTokenStrategyConfig(
        address token,
        address strategy,
        IL1TreasuryVault.VaultTokenStrategyConfig calldata cfg
    ) external onlyVaultAdmin {
        if (token == address(0) || strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        if (cfg.whitelisted && !_vaultTokenConfigs[token].supported) revert IL1TreasuryVault.TokenNotSupported();

        IL1TreasuryVault.VaultTokenStrategyConfig storage current = _vaultTokenStrategyConfigs[token][strategy];
        current.whitelisted = cfg.whitelisted;
        current.cap = cfg.cap;

        if (cfg.whitelisted) {
            if (!current.active) {
                current.active = true;
                _vaultTokenStrategies[token].push(strategy);
                _increaseGlobalActiveStrategy(strategy);
            }
            return;
        }

        current.active = false;
    }

    function allocateVaultTokenToStrategy(
        address token,
        address strategy,
        uint256 amount
    ) external nonReentrant onlyAllocator {
        if (_paused) revert IL1TreasuryVault.Paused();
        if (token == address(0) || strategy == address(0) || amount == 0) revert IL1TreasuryVault.InvalidParam();
        if (!_vaultTokenConfigs[token].supported) revert IL1TreasuryVault.TokenNotSupported();

        IL1TreasuryVault.VaultTokenStrategyConfig storage cfg = _vaultTokenStrategyConfigs[token][strategy];
        if (!cfg.whitelisted) revert IL1TreasuryVault.StrategyNotWhitelisted();

        IERC20 asset = IERC20(token);
        uint256 beforeBal = asset.balanceOf(address(this));
        asset.forceApprove(strategy, amount);
        IYieldStrategy(strategy).allocate(token, amount);
        asset.forceApprove(strategy, 0);
        uint256 afterBal = asset.balanceOf(address(this));
        if (afterBal > beforeBal) revert IL1TreasuryVault.InvalidParam();

        _strategyCostBasis[token][strategy] += beforeBal - afterBal;
    }

    function pause() external onlyPauserOrAdmin {
        if (_paused) revert IL1TreasuryVault.InvalidParam();
        _paused = true;
    }

    modifier onlyVaultAdmin() {
        if (!hasRole(VAULT_ADMIN_ROLE, msg.sender)) revert IL1TreasuryVault.Unauthorized();
        _;
    }

    modifier onlyPauserOrAdmin() {
        if (!(hasRole(PAUSER_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) {
            revert IL1TreasuryVault.Unauthorized();
        }
        _;
    }

    modifier onlyAllocator() {
        if (!hasRole(ALLOCATOR_ROLE, msg.sender)) revert IL1TreasuryVault.Unauthorized();
        _;
    }

    function _increaseGlobalActiveStrategy(address strategy) private {
        uint256 refs = _activeStrategyRefCount[strategy];
        if (refs == 0) {
            _activeStrategies.push(strategy);
        }
        _activeStrategyRefCount[strategy] = refs + 1;
    }
}
