// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title IStataTokenV2
 * @notice Minimal StataTokenV2 surface used by the SGHO strategy.
 * @dev Source surface:
 *      https://github.com/aave-dao/aave-v3-origin/blob/1e3d70c4151a94166ebc59e2eaa4aff6e6ba6978/src/contracts/extensions/stata-token/interfaces/IStataTokenV2.sol#L9
 */
interface IStataTokenV2 is IERC4626 {
    /**
     * @notice Returns the Aave aToken wrapped by this static token.
     */
    function aToken() external view returns (address);
}
