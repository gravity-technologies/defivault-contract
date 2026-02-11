// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {GRVTDeFiVault} from "../vault/GRVTDeFiVault.sol";

/**
 * @dev Test-only V2 mock for upgrade validation.
 * Appends storage and exposes a reinitializer to verify layout safety.
 */
contract GRVTDeFiVaultV2Mock is GRVTDeFiVault {
    uint256 public v2Marker;

    function initializeV2(uint256 marker_) external reinitializer(2) {
        if (marker_ == 0) revert InvalidParam();
        v2Marker = marker_;
    }
}
