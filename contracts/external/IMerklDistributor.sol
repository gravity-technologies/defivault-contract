// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IMerklDistributor
 * @notice Minimal Merkl distributor interface used by the GHO strategy claim flow.
 * @dev Merkl is maintained by Angle Labs / AngleProtocol. The distributor claims rewards by batch
 *      and pays the reward token to each user.
 */
interface IMerklDistributor {
    /**
     * @notice Claims rewards for one or more users and tokens.
     * @param users Reward recipients.
     * @param tokens Reward tokens.
     * @param amounts Cumulative claim amounts for each `(user, token)` pair.
     * @param proofs Merkle proofs for each claim item.
     */
    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external;
}
