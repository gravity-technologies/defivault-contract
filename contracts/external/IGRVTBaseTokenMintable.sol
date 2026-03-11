// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IGRVTBaseTokenMintable
 * @notice Minimal interface for the GRVT base token used to pay `mintValue` for L1->L2 bridge requests.
 * @dev GRVT uses a controlled base-token mint path to enforce private-chain deposit policy:
 * only flows backed by GRVT-controlled base token can be bridged to the private L2.
 *
 * Operational requirement:
 * the caller that initiates bridge requests and mints base token must be granted minter permission
 * on GRVT bridge infrastructure (for example, `GRVTBridgeProxy` in proxy-bridging-contracts).
 * Reference:
 * https://github.com/gravity-technologies/proxy-bridging-contracts/blob/f79d8f9beca5712c658ea9d6074f2f75ea2e70ea/contracts/proxy-bridging/GRVTBridgeProxy.sol
 */
interface IGRVTBaseTokenMintable is IERC20 {
    /**
     * @notice Mints base token to `to`.
     * @dev Access control is enforced by the concrete token implementation.
     * @param to Recipient of minted base token.
     * @param amount Amount to mint.
     */
    function mint(address to, uint256 amount) external;
}
