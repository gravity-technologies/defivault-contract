// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PositionComponent} from "./IVaultReportingTypes.sol";

/**
 * @title IYieldStrategyV2
 * @notice Single-lane strategy interface for the tracked/residual model.
 * @dev Each deployed strategy instance is bound to one vault-token lane. The lane token is exposed
 *      through `vaultToken()`. Internal assets, such as receipt tokens or middle-step tokens, stay
 *      internal to the strategy and are never public lane selectors.
 */
interface IYieldStrategyV2 {
    /// @notice Marker used by the vault to detect the V2 strategy surface.
    function isYieldStrategyV2() external pure returns (bytes4);

    /// @notice Returns the single vault token lane supported by this strategy deployment.
    function vaultToken() external view returns (address);

    /// @notice Human-readable strategy identifier.
    function name() external view returns (string memory);

    /// @notice Returns the strategy-held balance for one exact token address.
    /// @dev Unsupported token queries return `0`.
    function exactTokenBalance(address token) external view returns (uint256);

    /// @notice Returns the exact ERC20 tokens this strategy reports for its single configured lane.
    function tvlTokens() external view returns (address[] memory);

    /// @notice Returns the current token-by-token position breakdown for the configured lane.
    function positionBreakdown() external view returns (PositionComponent[] memory);

    /// @notice Returns total strategy exposure for the configured lane.
    function strategyExposure() external view returns (uint256);

    /// @notice Returns only the residual value currently realizable without touching tracked value.
    function residualExposure() external view returns (uint256);

    /// @notice Deposits vault-token value from the vault into the strategy's configured lane.
    function allocate(uint256 amount) external;

    /// @notice Withdraws tracked vault-funded value only.
    /// @return received Amount returned to the vault.
    /// @return reimbursableFee Explicit protocol exit fee for this tracked leg only.
    function withdrawTracked(uint256 amount) external returns (uint256 received, uint256 reimbursableFee);

    /// @notice Withdraws all remaining tracked vault-funded value only.
    /// @return received Amount returned to the vault.
    /// @return reimbursableFee Explicit protocol exit fee for this tracked leg only.
    function withdrawAllTracked() external returns (uint256 received, uint256 reimbursableFee);

    /// @notice Withdraws residual value only.
    /// @return received Amount returned to the vault.
    function withdrawResidual(uint256 amount) external returns (uint256 received);

    /// @notice Withdraws all remaining residual value.
    /// @return received Amount returned to the vault.
    function withdrawAllResidual() external returns (uint256 received);
}
