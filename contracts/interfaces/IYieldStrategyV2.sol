// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PositionComponent} from "./IVaultReportingTypes.sol";

/**
 * @title IYieldStrategyV2
 * @notice Stateless single-lane strategy interface for V2 vault-token adapters.
 *
 * Each deployed strategy instance is bound to one vault-token lane. The strategy is a pure fund
 * adapter: it allocates, withdraws, and reports exposure. It holds **zero** tracked-principal state.
 * The vault owns all accounting (cost basis, residual computation, fee inference, reimbursement).
 *
 * Amounts in this interface are in **vault-token units**:
 * - `totalExposure()` returns strategy value in vault-token units before exit fees.
 * - `allocate(amount)` pulls `amount` vault-token and returns `invested` (the strategy-reported
 *   net amount treated as deployed principal for V2 lanes).
 * - `withdraw(amount)` consumes `amount` of reported strategy value and returns `received` (net of exit fee).
 *
 * V2 deliberately uses a narrower trust model than legacy:
 * - the vault still measures balance changes and rejects impossible results,
 * - but V2 entry cost basis is derived from the strategy-reported `invested`,
 * - so governance-controlled V2 implementations are trusted to not underreport deployed principal.
 */
interface IYieldStrategyV2 {
    // --------- Identity / marker ---------

    /// @notice Marker used by the vault to detect the V2 strategy surface.
    /// @return selector The `isYieldStrategyV2()` selector.
    function isYieldStrategyV2() external pure returns (bytes4);

    /// @notice Returns the single vault token lane supported by this strategy deployment.
    /// @return token Vault token bound to this lane.
    function vaultToken() external view returns (address);

    // --------- Reporting ---------

    /**
     * @notice Returns total strategy value for the configured lane in vault-token units.
     * @dev The value is before exit fees, but entry fees are not added back. The vault compares this
     *      number with `costBasis` so that `residual = totalExposure - costBasis` captures yield
     *      appreciation, not entry or exit fees.
     * @return exposure Strategy value in vault-token units.
     */
    function totalExposure() external view returns (uint256 exposure);

    /// @notice Returns the strategy-held balance for one exact token address.
    /// @dev Unsupported token queries return `0`.
    /// @param token Exact token address to probe.
    /// @return amount Strategy-held balance for `token`.
    function exactTokenBalance(address token) external view returns (uint256 amount);

    /// @notice Returns the exact ERC20 tokens this strategy reports for its single configured lane.
    /// @return tokens Exact tokens the strategy may report through `exactTokenBalance`.
    function tvlTokens() external view returns (address[] memory tokens);

    /// @notice Returns the current token-by-token position breakdown for the configured lane.
    /// @return components Current position components for the lane.
    function positionBreakdown() external view returns (PositionComponent[] memory components);

    // --------- Fund movements ---------

    /**
     * @notice Deposits vault-token value from the vault into the strategy's configured lane.
     * @dev The strategy pulls `amount` vault-token from the vault, converts, and invests.
     *      Returns `invested`: the vault-token value the strategy reports as deployed principal
     *      for this allocation. The vault checks `invested <= spent`, but does not derive an
     *      independent lower bound on `invested` for V2 lanes. The vault uses `invested` for V2 cost
     *      basis, not `amount`.
     * @param amount Requested vault-token amount to allocate.
     * @return invested Strategy-reported vault-token value treated as deployed principal.
     */
    function allocate(uint256 amount) external returns (uint256 invested);

    /**
     * @notice Withdraws vault-token value from the strategy back to the vault.
     * @dev `amount` is strategy value, in vault-token units, to consume. The strategy converts that
     *      amount back to vault-token and sends it to the vault. Returns `received`: the actual
     *      vault-token sent (net of exit fee). The vault infers fee = amount - received.
     * @param amount Strategy value to consume, in vault-token units.
     * @return received Actual vault-token amount sent to the vault (net of exit fee).
     */
    function withdraw(uint256 amount) external returns (uint256 received);
}
