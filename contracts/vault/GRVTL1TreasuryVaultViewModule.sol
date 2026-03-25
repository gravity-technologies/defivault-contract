// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IL1TreasuryVault} from "../interfaces/IL1TreasuryVault.sol";
import {PositionComponent, ConservativeTokenTotals, TokenTotals} from "../interfaces/IVaultReportingTypes.sol";
import {VaultStrategyOpsLib} from "./VaultStrategyOpsLib.sol";

/**
 * @title GRVTL1TreasuryVaultViewModule
 * @notice External read helper for heavy vault reporting paths.
 * @dev This module is called by the vault implementation and does not own state itself.
 */
contract GRVTL1TreasuryVaultViewModule {
    /**
     * @notice Returns one strategy's current token-by-token position breakdown for a vault token.
     * @param vaultToken Vault token lane used for the read.
     * @param strategy Strategy address to inspect.
     * @param isActive Whether the vault currently treats the pair as active.
     * @return components Current position components for the pair.
     */
    function strategyPositionBreakdown(
        address vaultToken,
        address strategy,
        bool isActive
    ) external view returns (PositionComponent[] memory components) {
        _requireErc20Token(vaultToken);
        if (strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        if (!isActive) return components;
        return VaultStrategyOpsLib.readStrategyPositionBreakdownOrRevert(vaultToken, strategy);
    }

    /**
     * @notice Returns strict token totals for one tracked token.
     * @dev Reverts if any active strategy read fails or overflows.
     * @param vault Vault address whose idle balance should be counted.
     * @param token Token to total.
     * @param activeStrategies Active strategy set to scan.
     * @return totals Exact idle, strategy, and total balances for `token`.
     */
    function tokenTotals(
        address vault,
        address token,
        address[] calldata activeStrategies
    ) external view returns (TokenTotals memory totals) {
        _requireErc20Token(token);

        totals.idle = _idleTokenBalance(vault, token);
        totals.total = totals.idle;

        for (uint256 i = 0; i < activeStrategies.length; ++i) {
            (bool ok, uint256 amount) = VaultStrategyOpsLib.readStrategyExactTokenBalance(token, activeStrategies[i]);
            if (!ok) revert IL1TreasuryVault.InvalidStrategyTokenRead(token, activeStrategies[i]);
            if (amount > type(uint256).max - totals.strategy) {
                revert IL1TreasuryVault.InvalidStrategyTokenRead(token, activeStrategies[i]);
            }
            if (amount > type(uint256).max - totals.total) {
                revert IL1TreasuryVault.InvalidStrategyTokenRead(token, activeStrategies[i]);
            }
            totals.strategy += amount;
            totals.total += amount;
        }
    }

    /**
     * @notice Returns raw harvestable value for one `(token, strategy)` pair.
     * @dev Unified for V2 and legacy: `max(0, exposure - costBasis)`.
     *      V2 exposure is gross (before exit fee). This is a raw residual view, not policy-gated.
     * @param token Vault token lane to evaluate.
     * @param strategy Strategy address to evaluate.
     * @param canWithdraw Whether the vault currently allows deallocation from the pair.
     * @param costBasis Tracked principal attributed to the pair.
     * @return amount Current raw harvestable amount.
     */
    function harvestableYield(
        address token,
        address strategy,
        bool canWithdraw,
        uint256 costBasis
    ) external view returns (uint256 amount) {
        _requireErc20Token(token);
        if (strategy == address(0)) revert IL1TreasuryVault.InvalidParam();
        if (!canWithdraw) return 0;
        return VaultStrategyOpsLib.rawHarvestableYield(token, strategy, costBasis);
    }

    /**
     * @notice Returns best-effort token totals for one tracked token.
     * @dev Strategy read failures increment `skippedStrategies` instead of reverting.
     * @param vault Vault address whose idle balance should be counted.
     * @param token Token to total.
     * @param activeStrategies Active strategy set to scan.
     * @return status Conservative totals plus skipped-strategy count.
     */
    function tokenTotalsConservative(
        address vault,
        address token,
        address[] calldata activeStrategies
    ) external view returns (ConservativeTokenTotals memory status) {
        _requireErc20Token(token);
        return _buildConservativeTokenTotals(vault, token, activeStrategies);
    }

    /**
     * @notice Returns best-effort token totals for many tracked tokens.
     * @param vault Vault address whose idle balances should be counted.
     * @param tokens Tokens to total.
     * @param activeStrategies Active strategy set to scan for every token.
     * @return statuses One conservative total entry per input token.
     */
    function tokenTotalsBatch(
        address vault,
        address[] calldata tokens,
        address[] calldata activeStrategies
    ) external view returns (ConservativeTokenTotals[] memory statuses) {
        statuses = new ConservativeTokenTotals[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            _requireErc20Token(tokens[i]);
            statuses[i] = _buildConservativeTokenTotals(vault, tokens[i], activeStrategies);
        }
    }

    /**
     * @notice Returns the tracked TVL token list plus conservative totals for each token.
     * @param vault Vault address whose idle balances should be counted.
     * @param tokens Tracked TVL token set to copy and total.
     * @param activeStrategies Active strategy set to scan for every token.
     * @return copiedTokens Copy of the provided token list.
     * @return statuses One conservative total entry per copied token.
     */
    function trackedTvlTokenTotals(
        address vault,
        address[] calldata tokens,
        address[] calldata activeStrategies
    ) external view returns (address[] memory copiedTokens, ConservativeTokenTotals[] memory statuses) {
        copiedTokens = tokens;
        statuses = new ConservativeTokenTotals[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            statuses[i] = _buildConservativeTokenTotals(vault, tokens[i], activeStrategies);
        }
    }

    function _buildConservativeTokenTotals(
        address vault,
        address token,
        address[] calldata activeStrategies
    ) private view returns (ConservativeTokenTotals memory status) {
        status.idle = _idleTokenBalance(vault, token);
        status.total = status.idle;

        for (uint256 i = 0; i < activeStrategies.length; ++i) {
            (bool ok, uint256 amount) = VaultStrategyOpsLib.readStrategyExactTokenBalance(token, activeStrategies[i]);
            if (!ok || amount > type(uint256).max - status.strategy || amount > type(uint256).max - status.total) {
                unchecked {
                    ++status.skippedStrategies;
                }
                continue;
            }
            status.strategy += amount;
            status.total += amount;
        }
    }

    function _idleTokenBalance(address vault, address token) private view returns (uint256) {
        (bool ok, uint256 balance) = VaultStrategyOpsLib.tryBalanceOf(token, vault);
        if (!ok) return 0;
        return balance;
    }

    function _requireErc20Token(address token) private pure {
        if (token == address(0)) revert IL1TreasuryVault.InvalidParam();
    }
}
