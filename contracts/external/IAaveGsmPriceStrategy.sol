// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IAaveGsmPriceStrategy
 * @notice Minimal price-strategy surface used by the SGHO lane to validate GSM assumptions.
 */
interface IAaveGsmPriceStrategy {
    /**
     * @notice Returns the configured GSM price ratio.
     */
    function PRICE_RATIO() external view returns (uint256 ratio);
}
