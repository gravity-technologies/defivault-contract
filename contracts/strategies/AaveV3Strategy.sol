// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IAaveV3Pool} from "../external/IAaveV3Pool.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

contract AaveV3Strategy is Initializable, ReentrancyGuardUpgradeable, IYieldStrategy {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();

    address public vault;
    IAaveV3Pool public aavePool;
    address public underlying;
    address public aToken;
    string private _strategyName;

    event Allocated(address indexed token, uint256 amount, bytes data);
    event Deallocated(address indexed token, uint256 requested, uint256 received, bytes data);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address vault_,
        address aavePool_,
        address underlying_,
        address aToken_,
        string calldata strategyName_
    ) external initializer {
        if (
            vault_ == address(0) || aavePool_ == address(0) || underlying_ == address(0) || aToken_ == address(0)
                || bytes(strategyName_).length == 0
        ) revert InvalidParam();

        __ReentrancyGuard_init();

        vault = vault_;
        aavePool = IAaveV3Pool(aavePool_);
        underlying = underlying_;
        aToken = aToken_;
        _strategyName = strategyName_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    /// @inheritdoc IYieldStrategy
    function name() external view override returns (string memory) {
        return _strategyName;
    }

    /// @inheritdoc IYieldStrategy
    function assets(address token) external view override returns (uint256) {
        if (token != underlying) return 0;
        return IERC20(aToken).balanceOf(address(this));
    }

    /// @inheritdoc IYieldStrategy
    function allocate(address token, uint256 amount, bytes calldata data) external override onlyVault nonReentrant {
        if (token != underlying || amount == 0) revert InvalidParam();

        IERC20(token).safeTransferFrom(vault, address(this), amount);
        IERC20(token).forceApprove(address(aavePool), amount);
        aavePool.supply(token, amount, address(this), 0);
        IERC20(token).forceApprove(address(aavePool), 0);

        emit Allocated(token, amount, data);
    }

    /// @inheritdoc IYieldStrategy
    function deallocate(address token, uint256 amount, bytes calldata data)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 received)
    {
        if (token != underlying || amount == 0) revert InvalidParam();
        received = aavePool.withdraw(token, amount, vault);
        emit Deallocated(token, amount, received, data);
    }

    /// @inheritdoc IYieldStrategy
    function deallocateAll(address token, bytes calldata data)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 received)
    {
        if (token != underlying) revert InvalidParam();
        received = aavePool.withdraw(token, type(uint256).max, vault);
        emit Deallocated(token, type(uint256).max, received, data);
    }

    uint256[45] private __gap;
}
