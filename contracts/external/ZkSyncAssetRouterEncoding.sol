// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title ZkSyncAssetRouterEncoding
 * @notice Shared constants/helpers for zkSync Era asset-router deposit payloads.
 * @dev Matter Labs' current L1 asset-router stack identifies native ETH as `address(1)` in
 *      legacy two-bridges deposit payloads. Centralizing this avoids drift between production
 *      contracts and local mocks/tests when upstream bridge semantics evolve.
 *
 *      Upstream reference:
 *      https://github.com/matter-labs/era-contracts/blob/5e7d0b405b49f42131565a291a82f22565f72e33/l1-contracts/contracts/common/Config.sol#L111
 *      See `ETH_TOKEN_ADDRESS = address(1)`.
 */
library ZkSyncAssetRouterEncoding {
    /// @dev Current Matter Labs native-token sentinel used by the asset-router stack.
    address internal constant NATIVE_TOKEN_ADDRESS = address(1);

    /**
     * @notice Returns the current native-token sentinel used by the asset-router stack.
     */
    function nativeTokenAddress() internal pure returns (address) {
        return NATIVE_TOKEN_ADDRESS;
    }

    /**
     * @notice Builds the legacy native deposit tuple currently consumed by the asset router.
     * @param amount Native amount bridged.
     * @param l2Recipient Recipient on the target L2.
     * @return Encoded second-bridge calldata for the native deposit leg.
     */
    function encodeLegacyNativeDeposit(uint256 amount, address l2Recipient) internal pure returns (bytes memory) {
        return abi.encode(nativeTokenAddress(), amount, l2Recipient);
    }

    /**
     * @notice Returns true when `token` is the current native-token sentinel.
     * @param token Token identifier decoded from second-bridge calldata.
     */
    function isNativeToken(address token) internal pure returns (bool) {
        return token == nativeTokenAddress();
    }
}
