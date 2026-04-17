// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @dev Test-only V2 shim for upgrade validation.
 * Delegates all vault calls back to a deployed V1 implementation and exposes a V2-only
 * reinitializer so tests can verify upgrade execution without compiling a second full vault copy.
 */
contract GRVTL1TreasuryVaultV2Mock is Initializable {
    error InvalidParam();

    address public immutable implementation;

    event V2Initialized(uint256 marker);

    constructor(address implementation_) {
        if (implementation_ == address(0)) revert InvalidParam();
        implementation = implementation_;
    }

    function initializeV2(uint256 marker_) external reinitializer(2) {
        if (marker_ == 0) revert InvalidParam();
        emit V2Initialized(marker_);
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _delegate() internal {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
