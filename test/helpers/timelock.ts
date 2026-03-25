import { encodeFunctionData } from "viem";

type PublicClientLike = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type TimelockLike = {
  address: `0x${string}`;
  write: {
    schedule: (
      args: [
        `0x${string}`,
        bigint,
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        bigint,
      ],
    ) => Promise<`0x${string}`>;
    execute: (
      args: [
        `0x${string}`,
        bigint,
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
      ],
    ) => Promise<`0x${string}`>;
  };
};

type VaultLike = {
  address: `0x${string}`;
  abi: unknown;
  write: {
    setYieldRecipientTimelockController: (
      args: [`0x${string}`],
    ) => Promise<`0x${string}`>;
  };
};

export async function configureYieldRecipientTimelockController(
  viem: any,
  vault: VaultLike,
  adminAddress: `0x${string}`,
  minDelay: bigint = 2n,
) {
  const timelock = await viem.deployContract("TestTimelockController", [
    minDelay,
    [adminAddress],
    [adminAddress],
    adminAddress,
  ]);
  await vault.write.setYieldRecipientTimelockController([timelock.address]);
  return { timelock, minDelay };
}

export async function executeSetYieldRecipientViaTimelock(
  publicClient: PublicClientLike,
  vault: { address: `0x${string}`; abi: unknown },
  timelock: TimelockLike,
  newYieldRecipient: `0x${string}`,
  minDelay: bigint,
): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: vault.abi as any,
    functionName: "setYieldRecipient",
    args: [newYieldRecipient],
  });
  const zeroHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  await timelock.write.schedule([
    vault.address,
    0n,
    data,
    zeroHash,
    zeroHash,
    minDelay,
  ]);
  if (minDelay > 0n) {
    await increaseTimeAndMine(publicClient, Number(minDelay));
  }

  return timelock.write.execute([vault.address, 0n, data, zeroHash, zeroHash]);
}

export async function increaseTimeAndMine(
  publicClient: PublicClientLike,
  seconds: number,
) {
  await publicClient.request({
    method: "evm_increaseTime",
    params: [seconds],
  });
  await publicClient.request({
    method: "evm_mine",
    params: [],
  });
}
