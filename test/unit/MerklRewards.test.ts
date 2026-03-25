import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import {
  fetchMerklRewardClaim,
  selectMerklRewardClaim,
} from "../../tasks/utils/merkl-rewards.js";

describe("Merkl reward parsing", async function () {
  const recipient = getAddress("0x504E0B7dC9ED1071f3042b31Ee64DFEdc1b14E1d");
  const rewardToken = getAddress("0x1a88Df1cFe15Af22B3c4c783D4e6F7F9e0C1885d");

  it("selects the stkGHO reward entry and computes the claim delta", function () {
    const payload = [
      {
        chain: { id: 1 },
        rewards: [
          {
            root: "0x32e7dd925a1120609a03020746bab2ae53521d97b8101aa54d6946b6bc8069f5",
            recipient,
            amount: "58069886512706544",
            claimed: "20515745893106770",
            pending: "0",
            proofs: [
              "0x350b99a70072e399e62a77feb286a8ad54a3833a193d0d762da90eddb4691db1",
              "0xcdf8ba7595f375810391a20489ea8ca606e87985521ce651105318515416da45",
            ],
            token: {
              address: rewardToken,
              decimals: 18,
              symbol: "stkGHO",
            },
          },
        ],
      },
    ];

    const claim = selectMerklRewardClaim({
      apiUrl: "https://api.merkl.xyz/v4/users",
      payload,
      recipient,
      rewardToken,
    });

    assert.ok(claim);
    assert.equal(claim.recipient, recipient);
    assert.equal(claim.rewardToken, rewardToken);
    assert.equal(claim.cumulativeAmount, 58069886512706544n);
    assert.equal(claim.claimedAmount, 20515745893106770n);
    assert.equal(claim.claimableDelta, 37554140619599774n);
    assert.equal(claim.proofs.length, 2);
  });

  it("skips cleanly when the cumulative amount has already been claimed", function () {
    const claim = selectMerklRewardClaim({
      apiUrl: "https://api.merkl.xyz/v4/users",
      payload: [
        {
          chain: { id: 1 },
          rewards: [
            {
              recipient,
              amount: "1000",
              claimed: "1000",
              proofs: [],
              token: { address: rewardToken, symbol: "stkGHO" },
            },
          ],
        },
      ],
      recipient,
      rewardToken,
    });

    assert.equal(claim, null);
  });

  it("skips stale zero-delta rows and selects a later claimable row", function () {
    const claim = selectMerklRewardClaim({
      apiUrl: "https://api.merkl.xyz/v4/users",
      payload: [
        {
          chain: { id: 1 },
          rewards: [
            {
              recipient,
              amount: "1000",
              claimed: "1000",
              proofs: [],
              token: { address: rewardToken, symbol: "stkGHO" },
            },
            {
              recipient,
              amount: "2000",
              claimed: "500",
              proofs: [
                "0x1111111111111111111111111111111111111111111111111111111111111111",
              ],
              token: { address: rewardToken, symbol: "stkGHO" },
            },
          ],
        },
      ],
      recipient,
      rewardToken,
    });

    assert.ok(claim);
    assert.equal(claim.cumulativeAmount, 2000n);
    assert.equal(claim.claimableDelta, 1500n);
  });

  it("fails closed when a claimable entry is missing proofs", async function () {
    await assert.rejects(
      fetchMerklRewardClaim({
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              chain: { id: 1 },
              rewards: [
                {
                  recipient,
                  amount: "1000",
                  claimed: "0",
                  proofs: [],
                  token: { address: rewardToken, symbol: "stkGHO" },
                },
              ],
            },
          ],
        })) as unknown as typeof fetch,
        recipient,
        rewardToken,
      }),
      /missing proofs/,
    );
  });

  it("calls the Merkl API with the expected URL", async function () {
    let seenUrl = "";
    const claim = await fetchMerklRewardClaim({
      apiBase: "https://api.merkl.xyz",
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        seenUrl = String(input);
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              chain: { id: 1 },
              rewards: [
                {
                  recipient,
                  amount: "2",
                  claimed: "0",
                  proofs: [
                    "0x1111111111111111111111111111111111111111111111111111111111111111",
                  ],
                  token: { address: rewardToken, symbol: "stkGHO" },
                },
              ],
            },
          ],
        } as Response;
      }) as unknown as typeof fetch,
      recipient,
      rewardToken,
    });

    assert.ok(claim);
    assert.equal(
      seenUrl,
      `https://api.merkl.xyz/v4/users/${recipient}/rewards?chainId=1&reloadChainId=1`,
    );
  });
});
