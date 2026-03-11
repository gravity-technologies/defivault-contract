// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IAaveV3Pool
 * @notice Minimal interface for the Aave V3 Pool used by AaveV3Strategy.
 * @dev Covers only the `supply` and `withdraw` entry points needed for the strategy's
 *      allocate/deallocate lifecycle. The full Aave V3 Pool interface (flash loans,
 *      borrow, liquidation, etc.) is intentionally omitted.
 *
 *      Reference: Aave V3 Pool.sol — https://github.com/aave/aave-v3-core
 */
interface IAaveV3Pool {
    /**
     * @notice Supplies `amount` of `asset` into the Aave pool on behalf of `onBehalfOf`.
     * @dev Caller must have approved this pool for at least `amount` of `asset` before calling.
     *      The pool mints aTokens to `onBehalfOf` at the current liquidity index.
     *      AaveV3Strategy passes `address(this)` as `onBehalfOf` so aTokens accrue to the strategy.
     * @param asset        The ERC20 asset to supply (must be an Aave-supported reserve).
     * @param amount       Amount to supply, in the asset's native decimals.
     * @param onBehalfOf   Address that receives the minted aTokens.
     * @param referralCode Referral program code; pass 0 if not participating.
     */
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /**
     * @notice Withdraws `amount` of `asset` from the Aave pool and sends it to `to`.
     * @dev Burns aTokens from msg.sender (the strategy) at the current liquidity index.
     *      Pass `type(uint256).max` as `amount` to withdraw the full aToken balance.
     *      AaveV3Strategy passes `vault` as `to` so underlying lands directly in the vault
     *      without transiting through the strategy.
     * @param asset   The underlying ERC20 asset to withdraw.
     * @param amount  Amount to withdraw in underlying units, or `type(uint256).max` for full balance.
     * @param to      Address that receives the withdrawn underlying tokens.
     * @return        Actual amount of `asset` withdrawn (may differ from `amount` due to index rounding).
     */
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
