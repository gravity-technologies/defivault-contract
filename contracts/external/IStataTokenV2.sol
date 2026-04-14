// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title IStataTokenV2
 * @notice Minimal StataToken V2 surface used by the SGHO strategy.
 * @dev Source surface:
 *      https://github.com/bgd-labs/static-a-token-v3/blob/main/src/contracts/interfaces/IStaticATokenLM.sol
 */
interface IStataTokenV2 is IERC4626 {
    /**
     * @notice Returns the Aave aToken wrapped by this static token.
     */
    function aToken() external view returns (address);
}
