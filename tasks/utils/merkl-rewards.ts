import { getAddress, type Address, type Hex } from "viem";

export type MerklToken = {
  address?: string;
  decimals?: number;
  price?: number;
  symbol?: string;
};

export type MerklRewardEntry = {
  amount?: string | number | bigint;
  claimed?: string | number | bigint;
  distributionChainId?: number;
  pending?: string | number | bigint;
  proofs?: unknown;
  recipient?: string;
  root?: string;
  token?: MerklToken | string;
  tokenAddress?: string;
  address?: string;
};

export type MerklRewardsResponse =
  | Array<{
      chain?: { id?: number };
      rewards?: MerklRewardEntry[];
    }>
  | { rewards?: MerklRewardEntry[] };

export type MerklClaimPlan = {
  apiUrl: string;
  claimedAmount: bigint;
  claimableDelta: bigint;
  cumulativeAmount: bigint;
  proofs: Hex[];
  recipient: Address;
  rewardToken: Address;
  rewardTokenSymbol?: string;
  root?: Hex;
};

const DEFAULT_API_BASE = "https://api.merkl.xyz";
const MERKL_REWARDS_PATH = "/v4/users";

function parseBigint(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }
  throw new Error(`invalid ${label} in Merkl response`);
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label} in Merkl response`);
  }
  return getAddress(value);
}

function parseHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid ${label} in Merkl response`);
  }
  return value as Hex;
}

function normalizeProofs(value: unknown): Hex[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((proof, index) => parseHex(proof, `proofs[${index}]`));
}

function normalizeRewardToken(entry: MerklRewardEntry): {
  address: Address;
  symbol?: string;
} | null {
  const token = entry.token;
  if (typeof token === "string") {
    return { address: parseAddress(token, "token"), symbol: undefined };
  }
  if (typeof token === "object" && token !== null) {
    const address = token.address ?? entry.tokenAddress ?? entry.address;
    if (typeof address === "string" && address.length > 0) {
      return {
        address: parseAddress(address, "token.address"),
        symbol: typeof token.symbol === "string" ? token.symbol : undefined,
      };
    }
  }
  if (typeof entry.tokenAddress === "string" && entry.tokenAddress.length > 0) {
    return {
      address: parseAddress(entry.tokenAddress, "tokenAddress"),
      symbol: undefined,
    };
  }
  if (typeof entry.address === "string" && entry.address.length > 0) {
    return {
      address: parseAddress(entry.address, "address"),
      symbol: undefined,
    };
  }
  return null;
}

function normalizeRewardEntries(payload: unknown): MerklRewardEntry[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error("invalid Merkl response shape");
      }
      if (Array.isArray((entry as { rewards?: MerklRewardEntry[] }).rewards)) {
        return (entry as { rewards: MerklRewardEntry[] }).rewards ?? [];
      }
      return [entry as MerklRewardEntry];
    });
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { rewards?: MerklRewardEntry[] }).rewards)
  ) {
    return (payload as { rewards: MerklRewardEntry[] }).rewards ?? [];
  }
  throw new Error("invalid Merkl response shape");
}

export function selectMerklRewardClaim(args: {
  payload: unknown;
  recipient: Address;
  rewardToken: Address;
  minClaimDelta?: bigint;
  apiUrl: string;
}): MerklClaimPlan | null {
  const minClaimDelta = args.minClaimDelta ?? 0n;
  if (minClaimDelta < 0n) {
    throw new Error("invalid minClaimDelta");
  }

  const recipient = getAddress(args.recipient);
  const rewardToken = getAddress(args.rewardToken);
  const rewardTokenLower = rewardToken.toLowerCase();
  const entries = normalizeRewardEntries(args.payload);
  let bestClaim: MerklClaimPlan | null = null;

  for (const entry of entries) {
    const token = normalizeRewardToken(entry);
    if (token === null || token.address.toLowerCase() !== rewardTokenLower) {
      continue;
    }

    const entryRecipient = entry.recipient;
    if (
      typeof entryRecipient !== "string" ||
      getAddress(entryRecipient).toLowerCase() !== recipient.toLowerCase()
    ) {
      continue;
    }

    const cumulativeAmount = parseBigint(entry.amount, "amount");
    const claimedAmount = parseBigint(entry.claimed ?? 0n, "claimed");
    if (claimedAmount > cumulativeAmount) {
      throw new Error("invalid Merkl reward state");
    }

    const claimableDelta = cumulativeAmount - claimedAmount;
    if (claimableDelta === 0n || claimableDelta < minClaimDelta) {
      continue;
    }

    const proofs = normalizeProofs(entry.proofs);
    if (proofs.length === 0) {
      throw new Error("claimable Merkl reward is missing proofs");
    }

    const root =
      typeof entry.root === "string" && entry.root.length > 0
        ? parseHex(entry.root, "root")
        : undefined;

    const claim: MerklClaimPlan = {
      apiUrl: args.apiUrl,
      claimedAmount,
      claimableDelta,
      cumulativeAmount,
      proofs,
      recipient,
      rewardToken,
      rewardTokenSymbol: token.symbol,
      root,
    };

    if (
      bestClaim === null ||
      claim.cumulativeAmount > bestClaim.cumulativeAmount ||
      (claim.cumulativeAmount === bestClaim.cumulativeAmount &&
        claim.claimableDelta > bestClaim.claimableDelta)
    ) {
      bestClaim = claim;
    }
  }

  return bestClaim;
}

export async function fetchMerklRewardClaim(args: {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  minClaimDelta?: bigint;
  recipient: Address;
  rewardToken: Address;
}): Promise<MerklClaimPlan | null> {
  const apiBase = (args.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const apiUrl = new URL(
    `${MERKL_REWARDS_PATH}/${getAddress(args.recipient)}/rewards?chainId=1&reloadChainId=1`,
    `${apiBase}/`,
  ).toString();
  const response = await (args.fetchImpl ?? fetch)(apiUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Merkl request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return selectMerklRewardClaim({
    apiUrl,
    payload,
    recipient: args.recipient,
    rewardToken: args.rewardToken,
    minClaimDelta: args.minClaimDelta,
  });
}
