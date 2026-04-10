// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IStkGhoStaking
 * @notice Minimal live stkGHO token interface used by the strategy.
 * @dev This mirrors the stkGHO staking token surface from Aave's `StakedTokenV3`.
 *      Source:
 *      https://github.com/bgd-labs/aave-stk-v1-5/blob/main/src/interfaces/AggregatedStakedTokenV3.sol
 */
interface IStkGhoStaking {
    /**
     * @notice Returns the underlying token staked into stkGHO.
     * @return token GHO token address accepted by `stake`.
     */
    function STAKED_TOKEN() external view returns (address token);

    /**
     * @notice Returns the exchange-rate unit used by `getExchangeRate`.
     * @return unit Fixed-point scale for the exchange rate.
     */
    function EXCHANGE_RATE_UNIT() external view returns (uint256 unit);

    /**
     * @notice Returns the current stkGHO share exchange rate.
     * @return exchangeRate Current exchange rate as a fixed-point value.
     */
    function getExchangeRate() external view returns (uint216 exchangeRate);

    /**
     * @notice Returns the configured redeem cooldown.
     * @return cooldownSeconds Cooldown in seconds before `redeem` is allowed.
     */
    function getCooldownSeconds() external view returns (uint256 cooldownSeconds);

    /**
     * @notice Returns the number of shares minted for staking `assets`.
     * @param assets Amount of GHO to stake.
     * @return shares Amount of stkGHO shares to mint.
     */
    function previewStake(uint256 assets) external view returns (uint256 shares);

    /**
     * @notice Returns the amount of GHO redeemed for `shares`.
     * @param shares Amount of stkGHO to burn.
     * @return assets Amount of GHO returned.
     */
    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    /**
     * @notice Stakes GHO and mints stkGHO shares to `to`.
     * @param to Recipient of stkGHO shares.
     * @param amount Amount of GHO to stake.
     */
    function stake(address to, uint256 amount) external;

    /**
     * @notice Starts the cooldown required before redeeming.
     */
    function cooldown() external;

    /**
     * @notice Redeems stkGHO shares into GHO.
     * @param to Recipient of redeemed GHO.
     * @param amount Amount of stkGHO shares to redeem.
     */
    function redeem(address to, uint256 amount) external;
}
