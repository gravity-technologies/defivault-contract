// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IExchangeBridgeAdapter} from "../interfaces/IExchangeBridgeAdapter.sol";
import {IL1DefiVault} from "../interfaces/IL1DefiVault.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

contract GRVTDeFiVault is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, IL1DefiVault {
    using SafeERC20 for IERC20;

    bytes32 public constant override VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant override REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 public constant override ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant override PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant MAX_STRATEGIES_PER_TOKEN = 8;

    address private _bridgeAdapter;
    address private _l2ExchangeRecipient;
    bool private _paused;

    mapping(address token => TokenConfig cfg) private _tokenConfigs;
    mapping(address token => mapping(address strategy => StrategyConfig cfg)) private _strategyConfigs;
    mapping(address token => address[] strategies) private _tokenStrategies;
    mapping(address token => mapping(address strategy => uint256 indexPlusOne)) private _strategyIndexPlusOne;
    mapping(address token => uint64 lastTs) private _lastRebalanceAt;

    event BridgeAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);
    event L2ExchangeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event VaultPaused(address indexed account);
    event VaultUnpaused(address indexed account);
    event TokenConfigUpdated(address indexed token, TokenConfig cfg);
    event StrategyWhitelistUpdated(
        address indexed token, address indexed strategy, bool whitelisted, uint256 cap, bytes32 tag
    );
    event EmergencyStrategySkipped(address indexed token, address indexed strategy);

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

    modifier onlyAllocatorOrAdmin() {
        if (!(hasRole(ALLOCATOR_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
        _;
    }

    modifier onlyRebalancerOrAdmin() {
        if (!(hasRole(REBALANCER_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
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
    function isStrategyWhitelisted(address token, address strategy) external view override returns (bool) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return _strategyConfigs[token][strategy].whitelisted;
    }

    /// @inheritdoc IL1DefiVault
    function getStrategyConfig(address token, address strategy) external view override returns (StrategyConfig memory) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        return _strategyConfigs[token][strategy];
    }

    /// @inheritdoc IL1DefiVault
    function whitelistStrategy(address token, address strategy, StrategyConfig calldata cfg) external override onlyVaultAdmin {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        if (!_tokenConfigs[token].supported) revert TokenNotSupported();

        bool exists = _strategyIndexPlusOne[token][strategy] != 0;
        if (cfg.whitelisted) {
            if (!exists) _addStrategy(token, strategy);
        } else if (exists) {
            if (IYieldStrategy(strategy).assets(token) != 0) revert InvalidParam();
            _removeStrategy(token, strategy);
        }

        _strategyConfigs[token][strategy] = cfg;
        emit StrategyWhitelistUpdated(token, strategy, cfg.whitelisted, cfg.cap, cfg.tag);
    }

    /// @inheritdoc IL1DefiVault
    function idleAssets(address token) public view override returns (uint256) {
        if (token == address(0)) revert InvalidParam();
        return IERC20(token).balanceOf(address(this));
    }

    /// @inheritdoc IL1DefiVault
    function strategyAssets(address token, address strategy) public view override returns (uint256) {
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        if (!_strategyConfigs[token][strategy].whitelisted) return 0;
        return IYieldStrategy(strategy).assets(token);
    }

    /// @inheritdoc IL1DefiVault
    function totalAssets(address token) public view override returns (uint256 total) {
        if (token == address(0)) revert InvalidParam();

        total = idleAssets(token);
        address[] storage list = _tokenStrategies[token];
        uint256 len = list.length;
        // Intentionally unrolled (bounded by MAX_STRATEGIES_PER_TOKEN = 8) to avoid loop-based brittle TVL reads.
        if (len > 0) total += _safeStrategyAssets(token, list[0]);
        if (len > 1) total += _safeStrategyAssets(token, list[1]);
        if (len > 2) total += _safeStrategyAssets(token, list[2]);
        if (len > 3) total += _safeStrategyAssets(token, list[3]);
        if (len > 4) total += _safeStrategyAssets(token, list[4]);
        if (len > 5) total += _safeStrategyAssets(token, list[5]);
        if (len > 6) total += _safeStrategyAssets(token, list[6]);
        if (len > 7) total += _safeStrategyAssets(token, list[7]);
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
    function allocateToStrategy(address token, address strategy, uint256 amount, bytes calldata data)
        external
        override
        nonReentrant
        whenNotPaused
    {
        if (!hasRole(ALLOCATOR_ROLE, msg.sender)) revert Unauthorized();
        if (token == address(0) || strategy == address(0) || amount == 0) revert InvalidParam();

        TokenConfig memory cfg = _tokenConfigs[token];
        if (!cfg.supported) revert TokenNotSupported();
        StrategyConfig memory sCfg = _strategyConfigs[token][strategy];
        if (!sCfg.whitelisted) revert StrategyNotWhitelisted();

        uint256 idle = idleAssets(token);
        if (idle < amount || idle - amount < cfg.idleReserve) revert InvalidParam();

        if (sCfg.cap != 0) {
            uint256 current = IYieldStrategy(strategy).assets(token);
            if (current + amount > sCfg.cap) revert CapExceeded();
        }

        IERC20(token).forceApprove(strategy, amount);
        IYieldStrategy(strategy).allocate(token, amount, data);
        IERC20(token).forceApprove(strategy, 0);

        emit Allocate(token, strategy, amount, data);
    }

    /// @inheritdoc IL1DefiVault
    function deallocateFromStrategy(address token, address strategy, uint256 amount, bytes calldata data)
        external
        override
        nonReentrant
        returns (uint256 received)
    {
        if (!hasRole(ALLOCATOR_ROLE, msg.sender)) revert Unauthorized();
        if (token == address(0) || strategy == address(0) || amount == 0) revert InvalidParam();
        if (!_tokenConfigs[token].supported) revert TokenNotSupported();
        if (!_strategyConfigs[token][strategy].whitelisted) revert StrategyNotWhitelisted();

        received = IYieldStrategy(strategy).deallocate(token, amount, data);
        emit Deallocate(token, strategy, amount, received, data);
    }

    /// @inheritdoc IL1DefiVault
    function deallocateAllFromStrategy(address token, address strategy, bytes calldata data)
        external
        override
        nonReentrant
        returns (uint256 received)
    {
        if (!(hasRole(ALLOCATOR_ROLE, msg.sender) || hasRole(VAULT_ADMIN_ROLE, msg.sender))) revert Unauthorized();
        if (token == address(0) || strategy == address(0)) revert InvalidParam();
        if (!_tokenConfigs[token].supported) revert TokenNotSupported();
        if (!_strategyConfigs[token][strategy].whitelisted) revert StrategyNotWhitelisted();

        received = IYieldStrategy(strategy).deallocateAll(token, data);
        emit Deallocate(token, strategy, type(uint256).max, received, data);
    }

    /// @inheritdoc IL1DefiVault
    function rebalanceToL2(address token, uint256 amount, bytes calldata bridgeData)
        external
        override
        nonReentrant
        whenNotPaused
    {
        if (!hasRole(REBALANCER_ROLE, msg.sender)) revert Unauthorized();
        _rebalanceToL2(token, amount, bridgeData, true);
        emit RebalanceToL2(token, amount, bridgeData);
    }

    /// @inheritdoc IL1DefiVault
    /// @dev Intentionally bypasses `rebalanceMaxPerTx` and `rebalanceMinDelay` to prioritize
    ///      incident-time liquidity restoration for exchange withdrawals.
    function emergencySendToL2(address token, uint256 amount, bytes calldata bridgeData)
        external
        override
        nonReentrant
        onlyRebalancerOrAdmin
    {
        if (token == address(0) || amount == 0) revert InvalidParam();
        if (!_tokenConfigs[token].supported) revert TokenNotSupported();
        _validateBridgeConfig();
        _pullLiquidityFromStrategies(token, amount);

        if (idleAssets(token) < amount) revert InvalidParam();
        _bridgeToL2(token, amount, bridgeData);
        emit EmergencyToL2(token, amount, bridgeData);
    }

    /**
     * @notice Returns current whitelisted strategy list for a token.
     * @dev Array is bounded by MAX_STRATEGIES_PER_TOKEN.
     */
    function getTokenStrategies(address token) external view returns (address[] memory) {
        return _tokenStrategies[token];
    }

    /**
     * @notice Returns last successful rebalance timestamp for a token.
     * @dev Reserved for future rate-limit enforcement in fund-moving functions.
     */
    function lastRebalanceAt(address token) external view returns (uint64) {
        return _lastRebalanceAt[token];
    }

    function _rebalanceToL2(address token, uint256 amount, bytes calldata bridgeData, bool enforceRateLimits) internal {
        if (token == address(0) || amount == 0) revert InvalidParam();
        TokenConfig memory cfg = _tokenConfigs[token];
        if (!cfg.supported) revert TokenNotSupported();
        _validateBridgeConfig();

        if (cfg.rebalanceMaxPerTx != 0 && amount > cfg.rebalanceMaxPerTx) revert CapExceeded();
        if (amount > availableForRebalance(token)) revert InvalidParam();
        if (enforceRateLimits && cfg.rebalanceMinDelay != 0) {
            uint64 lastTs = _lastRebalanceAt[token];
            if (lastTs != 0 && block.timestamp < uint256(lastTs) + uint256(cfg.rebalanceMinDelay)) revert RateLimited();
            _lastRebalanceAt[token] = uint64(block.timestamp);
        } else if (_lastRebalanceAt[token] < uint64(block.timestamp)) {
            _lastRebalanceAt[token] = uint64(block.timestamp);
        }

        _bridgeToL2(token, amount, bridgeData);
    }

    function _pullLiquidityFromStrategies(address token, uint256 targetAmount) internal {
        uint256 idle = idleAssets(token);
        if (idle >= targetAmount) return;

        uint256 needed;
        unchecked {
            needed = targetAmount - idle;
        }

        address[] storage list = _tokenStrategies[token];
        for (uint256 i = 0; i < list.length && needed > 0; ++i) {
            address strategy = list[i];
            if (!_strategyConfigs[token][strategy].whitelisted) continue;

            uint256 strategyAssetsAmount = 0;
            try IYieldStrategy(strategy).assets(token) returns (uint256 assets_) {
                strategyAssetsAmount = assets_;
            } catch {
                emit EmergencyStrategySkipped(token, strategy);
                continue;
            }
            if (strategyAssetsAmount == 0) continue;

            uint256 request = needed < strategyAssetsAmount ? needed : strategyAssetsAmount;
            uint256 received = 0;
            try IYieldStrategy(strategy).deallocate(token, request, "") returns (uint256 received_) {
                received = received_;
            } catch {
                emit EmergencyStrategySkipped(token, strategy);
                continue;
            }

            emit Deallocate(token, strategy, request, received, "");
            if (received >= needed) {
                needed = 0;
                continue;
            }

            unchecked {
                needed -= received;
            }
        }
    }

    function _safeStrategyAssets(address token, address strategy) internal view returns (uint256 assets) {
        if (!_strategyConfigs[token][strategy].whitelisted) return 0;
        try IYieldStrategy(strategy).assets(token) returns (uint256 strategyAssetsAmount) {
            return strategyAssetsAmount;
        } catch {
            return 0;
        }
    }

    function _validateBridgeConfig() internal view {
        if (_bridgeAdapter == address(0) || _l2ExchangeRecipient == address(0)) revert InvalidParam();
    }

    function _bridgeToL2(address token, uint256 amount, bytes calldata bridgeData) internal {
        IERC20(token).forceApprove(_bridgeAdapter, amount);
        IExchangeBridgeAdapter(_bridgeAdapter).sendToL2(token, amount, _l2ExchangeRecipient, bridgeData);
        IERC20(token).forceApprove(_bridgeAdapter, 0);
    }

    function _addStrategy(address token, address strategy) internal {
        address[] storage list = _tokenStrategies[token];
        if (list.length >= MAX_STRATEGIES_PER_TOKEN) revert CapExceeded();
        list.push(strategy);
        _strategyIndexPlusOne[token][strategy] = list.length;
    }

    function _removeStrategy(address token, address strategy) internal {
        uint256 indexPlusOne = _strategyIndexPlusOne[token][strategy];
        if (indexPlusOne == 0) return;

        address[] storage list = _tokenStrategies[token];
        uint256 removeIndex = indexPlusOne - 1;
        uint256 lastIndex = list.length - 1;

        if (removeIndex != lastIndex) {
            address last = list[lastIndex];
            list[removeIndex] = last;
            _strategyIndexPlusOne[token][last] = indexPlusOne;
        }

        list.pop();
        delete _strategyIndexPlusOne[token][strategy];
    }

    uint256[44] private __gap;
}
