// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {GRVTL1TreasuryVault} from "../vault/GRVTL1TreasuryVault.sol";

/**
 * @dev Test-only V2 mock for upgrade validation.
 * Appends storage and exposes a reinitializer to verify layout safety.
 */
contract GRVTL1TreasuryVaultV2Mock is GRVTL1TreasuryVault {
    uint256 public v2Marker;

    function initializeV2(uint256 marker_) external reinitializer(2) {
        if (marker_ == 0) revert InvalidParam();
        v2Marker = marker_;
    }
}
