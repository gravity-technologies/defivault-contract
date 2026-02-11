// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Fee-on-transfer ERC20 mock.
 * Deducts basis-point fees on normal transfers to simulate deflationary token behavior in vault flows.
 */
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 public immutable feeBps;
    address public immutable feeCollector;
    uint8 private immutable _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBps_,
        address feeCollector_
    ) ERC20(name_, symbol_) {
        feeBps = feeBps_;
        feeCollector = feeCollector_;
        _customDecimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0 || feeCollector == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        uint256 net = value - fee;
        super._update(from, feeCollector, fee);
        super._update(from, to, net);
    }
}
