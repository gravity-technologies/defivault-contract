// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAaveV3AToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function POOL() external view returns (address);
}
