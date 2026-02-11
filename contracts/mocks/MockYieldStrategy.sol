// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";
import {
    TokenAmountComponent,
    TokenAmountComponentKind,
    StrategyAssetBreakdown
} from "../interfaces/IVaultReportingTypes.sol";

contract MockYieldStrategy is IYieldStrategy {
    struct MockComponent {
        address token;
        uint256 amount;
    }

    mapping(address token => uint256 amount) public mockedAssets;
    mapping(address token => bool value) public revertAssets;
    mapping(address token => bool value) public maxAssets;
    mapping(address queryToken => MockComponent[] components) private _mockedComponents;

    function name() external pure override returns (string memory) {
        return "MockYieldStrategy";
    }

    function setAssets(address token, uint256 amount) external {
        delete _mockedComponents[token];
        mockedAssets[token] = amount;
    }

    function setComponents(address queryToken, address[] calldata tokens, uint256[] calldata amounts) external {
        if (tokens.length != amounts.length) revert("BAD_COMPONENTS_LENGTH");
        delete _mockedComponents[queryToken];

        uint256 total;
        for (uint256 i = 0; i < tokens.length; ++i) {
            _mockedComponents[queryToken].push(MockComponent({token: tokens[i], amount: amounts[i]}));
            total += amounts[i];
        }
        mockedAssets[queryToken] = total;
    }

    function setRevertAssets(address token, bool value) external {
        revertAssets[token] = value;
    }

    function setMaxAssets(address token, bool value) external {
        maxAssets[token] = value;
    }

    function assets(address token) external view override returns (StrategyAssetBreakdown memory breakdown) {
        if (revertAssets[token]) revert("ASSETS_REVERT");

        MockComponent[] storage mocked = _mockedComponents[token];
        if (mocked.length != 0) {
            breakdown.components = new TokenAmountComponent[](mocked.length);
            for (uint256 i = 0; i < mocked.length; ++i) {
                breakdown.components[i] = TokenAmountComponent({
                    token: mocked[i].token,
                    amount: mocked[i].amount,
                    kind: TokenAmountComponentKind.InvestedPrincipal
                });
            }
            return breakdown;
        }

        uint256 amount = maxAssets[token] ? type(uint256).max : mockedAssets[token];
        if (amount == 0) return breakdown;

        breakdown.components = new TokenAmountComponent[](1);
        breakdown.components[0] = TokenAmountComponent({
            token: token,
            amount: amount,
            kind: TokenAmountComponentKind.InvestedPrincipal
        });
    }

    function principalBearingExposure(address token) external view override returns (uint256 exposure) {
        if (revertAssets[token]) revert("EXPOSURE_REVERT");
        if (maxAssets[token]) return type(uint256).max;
        return mockedAssets[token];
    }

    function allocate(address token, uint256 amount) external override {
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert("ALLOCATE_TRANSFER");
        mockedAssets[token] += amount;
    }

    function deallocate(address token, uint256 amount) external override returns (uint256 received) {
        uint256 current = mockedAssets[token];
        received = current < amount ? current : amount;
        mockedAssets[token] = current - received;
        if (received != 0 && !IERC20(token).transfer(msg.sender, received)) revert("DEALLOCATE_TRANSFER");
    }

    function deallocateAll(address token) external override returns (uint256 received) {
        received = mockedAssets[token];
        mockedAssets[token] = 0;
        if (received != 0 && !IERC20(token).transfer(msg.sender, received)) revert("DEALLOCATE_ALL_TRANSFER");
    }
}
