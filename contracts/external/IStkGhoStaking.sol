// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IStkGhoStaking
 * @notice Minimal upstream-derived stkGHO interface used by the strategy.
 * @dev This mirrors the ERC4626-style deposit/redeem surface exposed by Aave's `IStakeToken`.
 *      Sources:
 *      https://github.com/aave-dao/aave-umbrella/blob/8266de0b11ab0f78d1f31d7e0c1d716b4c9dad5d/src/contracts/stakeToken/interfaces/IStakeToken.sol
 *      https://github.com/aave-dao/aave-umbrella/blob/8266de0b11ab0f78d1f31d7e0c1d716b4c9dad5d/src/contracts/stakeToken/interfaces/IERC4626StakeToken.sol
 */
interface IStkGhoStaking {
    /**
     * @notice Returns the GHO asset accepted by this staking adapter.
     * @return token GHO token address used on deposit and redeem.
     */
    function gho() external view returns (address token);

    /**
     * @notice Returns the stkGHO share token minted and burned by this adapter.
     * @return token stkGHO token address represented by adapter shares.
     */
    function stkGho() external view returns (address token);

    /**
     * @notice Converts `shares` into currently redeemable GHO assets.
     * @param shares Amount of stkGHO shares.
     * @return assets Amount of GHO assets currently represented by `shares`.
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /**
     * @notice Returns the number of shares that must be burned to withdraw `assets`.
     * @param assets Amount of GHO assets to withdraw.
     * @return shares Amount of stkGHO shares that must be burned.
     */
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);

    /**
     * @notice Deposits GHO and mints stkGHO shares.
     * @param assets Amount of GHO to stake.
     * @param receiver Recipient of stkGHO shares.
     * @return shares Amount of stkGHO minted.
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /**
     * @notice Burns stkGHO shares and returns GHO.
     * @param shares Amount of stkGHO to burn.
     * @param receiver Recipient of unstaked GHO.
     * @param owner Owner of the stkGHO shares being redeemed.
     * @return assets Amount of GHO returned.
     */
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}
