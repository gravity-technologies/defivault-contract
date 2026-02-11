// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IExchangeBridgeAdapter} from "../interfaces/IExchangeBridgeAdapter.sol";

contract ZkSyncNativeBridgeAdapter is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, IExchangeBridgeAdapter {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidParam();

    bytes32 public constant ADAPTER_ADMIN_ROLE = keccak256("ADAPTER_ADMIN_ROLE");

    address public vault;
    address public custody;
    mapping(address caller => bool allowed) private _trustedInboundCallers;

    event SentToL2(address indexed token, uint256 amount, address indexed l2Recipient, bytes data);
    event TrustedInboundCallerSet(address indexed caller, bool allowed);
    event CustodyUpdated(address indexed previousCustody, address indexed newCustody);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address vault_, address custody_, address trustedInboundCaller) external initializer {
        if (admin == address(0) || vault_ == address(0) || custody_ == address(0)) revert InvalidParam();

        __AccessControl_init();
        __ReentrancyGuard_init();

        _setRoleAdmin(ADAPTER_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADAPTER_ADMIN_ROLE, admin);

        vault = vault_;
        custody = custody_;

        if (trustedInboundCaller != address(0)) {
            _trustedInboundCallers[trustedInboundCaller] = true;
            emit TrustedInboundCallerSet(trustedInboundCaller, true);
        }
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    /// @inheritdoc IExchangeBridgeAdapter
    /// @dev Design choice (v1): tokens are transferred to `custody` on L1, while
    ///      `l2Recipient` is validated and emitted as routing metadata for downstream
    ///      bridge/custody processing. This adapter does not enforce final L2 delivery on-chain.
    function sendToL2(address token, uint256 amount, address l2Recipient, bytes calldata data)
        external
        override
        onlyVault
        nonReentrant
    {
        if (token == address(0) || amount == 0 || l2Recipient == address(0)) revert InvalidParam();

        IERC20(token).safeTransferFrom(vault, custody, amount);
        emit SentToL2(token, amount, l2Recipient, data);
    }

    /// @inheritdoc IExchangeBridgeAdapter
    function isTrustedInboundCaller(address caller) external view override returns (bool) {
        return _trustedInboundCallers[caller];
    }

    function setTrustedInboundCaller(address caller, bool allowed) external onlyRole(ADAPTER_ADMIN_ROLE) {
        if (caller == address(0)) revert InvalidParam();
        _trustedInboundCallers[caller] = allowed;
        emit TrustedInboundCallerSet(caller, allowed);
    }

    function setCustody(address newCustody) external onlyRole(ADAPTER_ADMIN_ROLE) {
        if (newCustody == address(0)) revert InvalidParam();
        address previous = custody;
        custody = newCustody;
        emit CustodyUpdated(previous, newCustody);
    }

    uint256[46] private __gap;
}
