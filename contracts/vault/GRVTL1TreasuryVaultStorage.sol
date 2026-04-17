// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";

/**
 * @title GRVTL1TreasuryVaultStorage
 * @notice Shared storage layout for the L1 treasury vault and delegatecall helper modules.
 * @dev Keep field order exactly aligned with the upgradeable vault implementation.
 */
abstract contract GRVTL1TreasuryVaultStorage {
    /// @dev L1 BridgeHub contract used for outbound L1 → L2 transfers.
    address internal _bridgeHub;

    /// @dev GRVT bridge-proxy fee token used for BridgeHub `mintValue` funding.
    address internal _grvtBridgeProxyFeeToken;

    /// @dev Target L2 chain id passed into BridgeHub requests.
    uint256 internal _l2ChainId;

    /// @dev Configured L2 exchange recipient for normal top-ups.
    address internal _l2ExchangeRecipient;

    /// @dev Wrapped-native ERC20 token used for internal accounting and strategy calls.
    address internal _wrappedNativeToken;

    /// @dev Native bridge gateway used for L1 -> L2 native sends and failed-deposit recovery.
    address internal _nativeBridgeGateway;

    /// @dev Native dust/forced-send sweep yield recipient.
    address internal _yieldRecipient;

    /// @dev Global pause flag. When true, blocks `allocateVaultTokenToStrategy` and normal rebalances.
    bool internal _paused;

    /// @dev Per-token support and risk-control parameters.
    mapping(address token => IL1TreasuryVault.VaultTokenConfig cfg) internal _vaultTokenConfigs;
    /// @dev Per-(token,strategy) tracked cost basis used for yield/loss reconciliation.
    mapping(address token => mapping(address strategy => uint256 costBasis)) internal _strategyCostBasis;
    /// @dev Per-(token,strategy) whitelist, active flag, and allocation-cap config.
    mapping(address token => mapping(address strategy => IL1TreasuryVault.VaultTokenStrategyConfig cfg))
        internal _vaultTokenStrategyConfigs;
    /// @dev Strategy registry per vault token, including withdraw-only pairs that remain active.
    mapping(address token => address[] strategies) internal _vaultTokenStrategies;
    /// @dev Global set of strategies with at least one active lane, used for cross-token reporting scans.
    address[] internal _activeStrategies;
    /// @dev Reference count per strategy across active lanes in `_vaultTokenStrategies`.
    mapping(address strategy => uint256 refs) internal _activeStrategyRefCount;
    /// @dev Ordered set of currently supported vault tokens.
    address[] internal _supportedVaultTokens;
    /// @dev Membership set for `_supportedVaultTokens`.
    mapping(address token => bool supported) internal _supportedVaultTokenSet;
    /// @dev Ordered set of currently tracked TVL tokens.
    address[] internal _trackedTvlTokens;
    /// @dev Membership set for `_trackedTvlTokens`.
    mapping(address token => bool tracked) internal _trackedTvlTokenSet;
    /// @dev Reference count per tracked TVL token across direct tracking and strategy-declared TVL token lists.
    mapping(address token => uint256 refs) internal _trackedTvlTokenRefCount;
    /// @dev Whether a supported vault token is currently tracked directly as part of vault TVL.
    mapping(address token => bool trackedDirectly) internal _vaultTokenDirectTvlTracked;
    /// @dev Cached TVL token lists declared by each active `(vaultToken, strategy)` pair.
    mapping(address vaultToken => mapping(address strategy => address[] tokens)) internal _cachedStrategyTvlTokens;
    /// @dev Whether an operator override exists for one tracked TVL token.
    mapping(address token => bool enabled) internal _trackedTvlTokenOverrideEnabled;
    /// @dev Forced tracked/untracked value for one TVL token when override is enabled.
    mapping(address token => bool forceTrack) internal _trackedTvlTokenOverrideValue;
    /// @dev Timelock controller allowed to rotate `_yieldRecipient`.
    address internal _yieldRecipientTimelockController;
    /// @dev Whether one supported vault token may use the generic ERC20 bridge path.
    mapping(address token => bool bridgeable) internal _bridgeableVaultTokens;
    /// @dev Per-(token,strategy) policy config for policy-native lanes.
    mapping(address token => mapping(address strategy => IL1TreasuryVault.StrategyPolicyConfig cfg))
        internal _strategyPolicyConfigs;
    /// @dev Whether a policy config has been bound for one `(token, strategy)` pair.
    mapping(address token => mapping(address strategy => bool configured)) internal _hasStrategyPolicyConfig;
    /// @dev Ordered set of vault tokens that currently have at least one live strategy lane in `_vaultTokenStrategies`.
    address[] internal _activeStrategyVaultTokens;
    /// @dev Membership set for `_activeStrategyVaultTokens`.
    mapping(address token => bool tracked) internal _activeStrategyVaultTokenSet;

    /// @dev Reserved storage gap for upgrade-safe layout extension (45 × 32 bytes).
    uint256[45] internal __gap;
}
