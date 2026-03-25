// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMerklDistributor} from "../external/IMerklDistributor.sol";

/**
 * @title MockAngleRewardsDistributor
 * @notice Test-only cumulative reward distributor for stkGHO claims.
 */
contract MockAngleRewardsDistributor is IMerklDistributor {
    using SafeERC20 for IERC20;

    error InvalidParam();
    error InvalidProof();

    address public immutable rewardToken;

    mapping(address user => mapping(address token => uint256 amount)) public cumulativeClaimable;
    mapping(address user => mapping(address token => uint256 amount)) public cumulativeClaimed;
    mapping(address user => mapping(address token => bytes32 proofHash)) public expectedProofHash;

    constructor(address rewardToken_) {
        if (rewardToken_ == address(0)) revert InvalidParam();
        rewardToken = rewardToken_;
    }

    /**
     * @notice Sets the cumulative claimable amount and expected proof hash for one claim target.
     */
    function setClaimable(address user, address token, uint256 cumulativeAmount, bytes32 proofHash) external {
        if (user == address(0) || token == address(0)) revert InvalidParam();
        cumulativeClaimable[user][token] = cumulativeAmount;
        expectedProofHash[user][token] = proofHash;
    }

    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external override {
        if (
            users.length == 0 ||
            users.length != tokens.length ||
            users.length != amounts.length ||
            users.length != proofs.length
        ) revert InvalidParam();

        for (uint256 i = 0; i < users.length; ++i) {
            address user = users[i];
            address token = tokens[i];
            uint256 cumulativeAmount = amounts[i];
            if (user == address(0) || token == address(0) || token != rewardToken || cumulativeAmount == 0)
                revert InvalidParam();

            if (keccak256(abi.encode(proofs[i])) != expectedProofHash[user][token]) {
                revert InvalidProof();
            }

            uint256 claimable = cumulativeClaimable[user][token];
            uint256 alreadyClaimed = cumulativeClaimed[user][token];
            if (cumulativeAmount > claimable || cumulativeAmount < alreadyClaimed) {
                revert InvalidParam();
            }

            uint256 delta = cumulativeAmount - alreadyClaimed;
            if (delta == 0) continue;

            cumulativeClaimed[user][token] = cumulativeAmount;
            IERC20(token).safeTransfer(user, delta);
        }
    }
}
