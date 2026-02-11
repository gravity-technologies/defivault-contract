// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IL1DefiVault} from "../interfaces/IL1DefiVault.sol";

contract GRVTDeFiVault is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, IL1DefiVault {
    bytes32 public constant override VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant override REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant override ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant override PAUSER_ROLE = keccak256("PAUSER_ROLE");

    address private _bridgeAdapter;
    address private _l2ExchangeRecipient;
    bool private _paused;

    mapping(address token => TokenConfig cfg) private _tokenConfigs;
    mapping(address token => uint64 lastTs) private _lastRebalanceAt;

    event BridgeAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);
    event L2ExchangeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event VaultPaused(address indexed account);
    event VaultUnpaused(address indexed account);
    event TokenConfigUpdated(address indexed token, TokenConfig cfg);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable vault.
     * @param admin Initial governance admin account.
     * @param bridgeAdapter_ Initial bridge adapter used for L1->L2 sends.
     * @param l2ExchangeRecipient_ Initial L2 exchange recipient address.
     */
    function initialize(address admin, address bridgeAdapter_, address l2ExchangeRecipient_) external initializer {
        if (admin == address(0) || bridgeAdapter_ == address(0) || l2ExchangeRecipient_ == address(0)) {
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

        _bridgeAdapter = bridgeAdapter_;
        _l2ExchangeRecipient = l2ExchangeRecipient_;
    }

    modifier onlyVaultAdmin() {
        if (!hasRole(VAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyPauserOrAdmin() {
        if (!(hasRole(PAUSER_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (_paused) revert Paused();
        _;
    }

    /// @inheritdoc IL1DefiVault
    function hasRole(bytes32 role, address account)
        public
        view
        override(AccessControlUpgradeable, IL1DefiVault)
        returns (bool)
    {
        return super.hasRole(role, account);
    }

    /// @inheritdoc IL1DefiVault
    function bridgeAdapter() external view override returns (address) {
        return _bridgeAdapter;
    }

    /// @inheritdoc IL1DefiVault
    function l2ExchangeRecipient() external view override returns (address) {
        return _l2ExchangeRecipient;
    }

    /// @inheritdoc IL1DefiVault
    function paused() external view override returns (bool) {
        return _paused;
    }

    /// @inheritdoc IL1DefiVault
    function setBridgeAdapter(address adapter) external override onlyVaultAdmin {
        if (adapter == address(0)) revert InvalidParam();
        address previous = _bridgeAdapter;
        _bridgeAdapter = adapter;
        emit BridgeAdapterUpdated(previous, adapter);
    }

    /// @inheritdoc IL1DefiVault
    function setL2ExchangeRecipient(address l2Recipient) external override onlyVaultAdmin {
        if (l2Recipient == address(0)) revert InvalidParam();
        address previous = _l2ExchangeRecipient;
        _l2ExchangeRecipient = l2Recipient;
        emit L2ExchangeRecipientUpdated(previous, l2Recipient);
    }

    /// @inheritdoc IL1DefiVault
    function pause() external override onlyPauserOrAdmin {
        if (_paused) revert InvalidParam();
        _paused = true;
        emit VaultPaused(msg.sender);
    }

    /// @inheritdoc IL1DefiVault
    function unpause() external override onlyPauserOrAdmin {
        if (!_paused) revert InvalidParam();
        _paused = false;
        emit VaultUnpaused(msg.sender);
    }

    /// @inheritdoc IL1DefiVault
    function getTokenConfig(address token) external view override returns (TokenConfig memory) {
        return _tokenConfigs[token];
    }

    /// @inheritdoc IL1DefiVault
    function setTokenConfig(address token, TokenConfig calldata cfg) external override onlyVaultAdmin {
        if (token == address(0)) revert InvalidParam();
        _tokenConfigs[token] = cfg;
        emit TokenConfigUpdated(token, cfg);
    }

    /// @inheritdoc IL1DefiVault
    function isStrategyWhitelisted(address token, address strategy) external pure override returns (bool) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return false;
    }

    /// @inheritdoc IL1DefiVault
    function getStrategyConfig(address token, address strategy) external pure override returns (StrategyConfig memory) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return StrategyConfig({whitelisted: false, cap: 0, tag: bytes32(0)});
    }

    /// @inheritdoc IL1DefiVault
    function whitelistStrategy(address, address, StrategyConfig calldata) external view override onlyVaultAdmin {
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function idleAssets(address token) public view override returns (uint256) {
        if (token == address(0)) revert InvalidParam();
        return IERC20(token).balanceOf(address(this));
    }

    /// @inheritdoc IL1DefiVault
    function strategyAssets(address token, address strategy) public pure override returns (uint256) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return 0;
    }

    /// @inheritdoc IL1DefiVault
    function totalAssets(address token) public view override returns (uint256 total) {
        if (token == address(0)) revert InvalidParam();

        total = idleAssets(token);
    }

    /// @inheritdoc IL1DefiVault
    function availableForRebalance(address token) public view override returns (uint256) {
        if (token == address(0)) revert InvalidParam();

        TokenConfig memory cfg = _tokenConfigs[token];
        if (!cfg.supported) return 0;

        uint256 idle = idleAssets(token);
        if (idle <= cfg.idleReserve) return 0;
        unchecked {
            return idle - cfg.idleReserve;
        }
    }

    /// @inheritdoc IL1DefiVault
    function allocateToStrategy(address, address, uint256, bytes calldata) external pure override {
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function deallocateFromStrategy(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (uint256 received)
    {
        received = 0;
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function deallocateAllFromStrategy(address, address, bytes calldata)
        external
        pure
        override
        returns (uint256 received)
    {
        received = 0;
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function rebalanceToL2(address, uint256, bytes calldata) external pure override {
        revert InvalidParam();
    }

    /// @inheritdoc IL1DefiVault
    function emergencySendToL2(address, uint256, bytes calldata) external pure override {
        revert InvalidParam();
    }

    /**
     * @notice Returns current whitelisted strategy list for a token.
     * @dev Array is bounded by MAX_STRATEGIES_PER_TOKEN.
     */
    function getTokenStrategies(address token) external pure returns (address[] memory) {
        token;
        return new address[](0);
    }

    /**
     * @notice Returns last successful rebalance timestamp for a token.
     * @dev Reserved for future rate-limit enforcement in fund-moving functions.
     */
    function lastRebalanceAt(address token) external view returns (uint64) {
        return _lastRebalanceAt[token];
    }

    uint256[44] private __gap;
}
