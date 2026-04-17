// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IAaveGsmFeeStrategy
 * @notice Minimal fee-strategy surface used by the SGHO lane to validate GSM assumptions.
 */
interface IAaveGsmFeeStrategy {
    /**
     * @notice Returns the buy-side fee for `amount`.
     */
    function getBuyFee(uint256 amount) external view returns (uint256 fee);

    /**
     * @notice Returns the sell-side fee for `amount`.
     */
    function getSellFee(uint256 amount) external view returns (uint256 fee);
}
