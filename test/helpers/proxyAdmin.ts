import assert from "node:assert/strict";

import { getAddress, parseAbi } from "viem";

const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

export const proxyAdminAbi = parseAbi([
  "function owner() view returns (address)",
  "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
  "error OwnableUnauthorizedAccount(address account)",
]);

export async function readProxyAdminAddress(
  publicClient: { getStorageAt(args: { address: `0x${string}`; slot: `0x${string}` }): Promise<`0x${string}` | undefined> },
  proxyAddress: `0x${string}`,
): Promise<`0x${string}`> {
  const raw = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_ADMIN_SLOT,
  });

  assert.notEqual(raw, undefined, "missing proxy admin slot value");
  const hex = raw.slice(2);
  const admin = `0x${hex.slice(24)}` as `0x${string}`;
  return getAddress(admin);
}
