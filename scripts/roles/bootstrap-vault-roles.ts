import { network } from "hardhat";

function requireEnv(name: string): `0x${string}` {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value as `0x${string}`;
}

function parseAddressList(envName: string): Array<`0x${string}`> {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as Array<`0x${string}`>;
}

const VAULT_PROXY = requireEnv("VAULT_PROXY");
const ALLOCATOR_ADDRESSES = parseAddressList("ALLOCATOR_ADDRESSES");
const REBALANCER_ADDRESSES = parseAddressList("REBALANCER_ADDRESSES");
const PAUSER_ADDRESSES = parseAddressList("PAUSER_ADDRESSES");
const BRIDGE_ADAPTER = process.env.BRIDGE_ADAPTER as `0x${string}` | undefined;
const L2_EXCHANGE_RECIPIENT = process.env.L2_EXCHANGE_RECIPIENT as
  | `0x${string}`
  | undefined;

const { viem, networkName } = await network.connect();
const vault = await viem.getContractAt("GRVTDeFiVault", VAULT_PROXY);

console.log(`Bootstrapping roles for vault ${VAULT_PROXY} on ${networkName}`);

async function grantMany(role: `0x${string}`, addresses: Array<`0x${string}`>) {
  for (const address of addresses) {
    const has = await vault.read.hasRole([role, address]);
    if (has) {
      console.log(`Role already granted: ${role} -> ${address}`);
      continue;
    }
    await vault.write.grantRole([role, address]);
    console.log(`Granted role: ${role} -> ${address}`);
  }
}

await grantMany(await vault.read.ALLOCATOR_ROLE(), ALLOCATOR_ADDRESSES);
await grantMany(await vault.read.REBALANCER_ROLE(), REBALANCER_ADDRESSES);
await grantMany(await vault.read.PAUSER_ROLE(), PAUSER_ADDRESSES);

if (BRIDGE_ADAPTER !== undefined) {
  await vault.write.setBridgeAdapter([BRIDGE_ADAPTER]);
  console.log(`Updated bridge adapter: ${BRIDGE_ADAPTER}`);
}

if (L2_EXCHANGE_RECIPIENT !== undefined) {
  await vault.write.setL2ExchangeRecipient([L2_EXCHANGE_RECIPIENT]);
  console.log(`Updated L2 recipient: ${L2_EXCHANGE_RECIPIENT}`);
}

console.log("Role bootstrap complete");
