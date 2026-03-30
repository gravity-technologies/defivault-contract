import { getAddress, parseAbi, type Address, type Hex } from "viem";

export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

export const proxyAdminAbi = parseAbi([
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
]);

type StorageReader = {
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
};

export async function readProxyAdminAddress(
  publicClient: StorageReader,
  proxyAddress: Address,
): Promise<Address> {
  const raw = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_ADMIN_SLOT,
  });

  if (raw === undefined) {
    throw new Error("missing proxy admin slot value");
  }

  const hex = raw.slice(2);
  const admin = `0x${hex.slice(24)}` as Address;
  return getAddress(admin);
}
