// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library Errors {
    error Unauthorized();
    error Paused();
    error TokenNotSupported();
    error StrategyNotWhitelisted();
    error InvalidParam();
    error CapExceeded();
    error RateLimited();
    error UnsafeDestination();
}
