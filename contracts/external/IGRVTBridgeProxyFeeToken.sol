// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IGRVTBridgeProxyFeeToken
 * @notice Minimal interface for the GRVT bridge-proxy fee token used to pay `mintValue` for L1->L2 bridge requests.
 * @dev GRVT uses a controlled bridge-proxy fee-token mint path to enforce private-chain deposit policy:
 * only flows backed by GRVT-controlled fee token can be bridged to the private L2.
 *
 * Operational requirement:
 * the caller that initiates bridge requests and mints the fee token must be granted minter permission
 * on GRVT bridge infrastructure (for example, `GRVTBridgeProxy` in proxy-bridging-contracts).
 * Reference:
 * https://github.com/gravity-technologies/proxy-bridging-contracts/blob/f79d8f9beca5712c658ea9d6074f2f75ea2e70ea/contracts/proxy-bridging/GRVTBridgeProxy.sol
 */
interface IGRVTBridgeProxyFeeToken is IERC20 {
    /**
     * @notice Mints bridge-proxy fee token to `to`.
     * @dev Access control is enforced by the concrete token implementation.
     * @param to Recipient of minted fee token.
     * @param amount Amount to mint.
     */
    function mint(address to, uint256 amount) external;
}
