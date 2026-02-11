import { network } from "hardhat";
import { encodeFunctionData, getContractAddress, zeroAddress } from "viem";

function requireEnv(name: string): `0x${string}` {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value as `0x${string}`;
}

function optionalEnv(name: string): `0x${string}` | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value as `0x${string}`;
}

const DEPLOY_ADMIN = requireEnv("DEPLOY_ADMIN");
const L2_EXCHANGE_RECIPIENT = requireEnv("L2_EXCHANGE_RECIPIENT");
const CUSTODY_ADDRESS = requireEnv("CUSTODY_ADDRESS");
const AAVE_POOL = requireEnv("AAVE_POOL");
const UNDERLYING_TOKEN = requireEnv("UNDERLYING_TOKEN");
const A_TOKEN = requireEnv("A_TOKEN");
const TRUSTED_INBOUND_CALLER = optionalEnv("TRUSTED_INBOUND_CALLER") ?? zeroAddress;
const STRATEGY_NAME = process.env.STRATEGY_NAME ?? "AAVE_V3_USDT";

const { viem, networkName } = await network.connect();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
if (deployer.account === undefined) {
  throw new Error("Missing deployer account");
}
const deployerAddress = deployer.account.address;
const deployerNonce = await publicClient.getTransactionCount({ address: deployerAddress });

// Expected CREATE sequence:
// n + 0: vaultImpl
// n + 1: strategyImpl
// n + 2: adapterImpl
// n + 3: adapterProxy
// n + 4: vaultProxy
// n + 5: strategyProxy
const predictedAdapterProxy = getContractAddress({
  from: deployerAddress,
  nonce: deployerNonce + 3n,
});
const predictedVaultProxy = getContractAddress({
  from: deployerAddress,
  nonce: deployerNonce + 4n,
});

console.log(`Deploying vault stack on network: ${networkName}`);
console.log(`Admin: ${DEPLOY_ADMIN}`);

const vaultImpl = await viem.deployContract("GRVTDeFiVault");
const strategyImpl = await viem.deployContract("AaveV3Strategy");
const adapterImpl = await viem.deployContract("ZkSyncNativeBridgeAdapter");

const adapterProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
  adapterImpl.address,
  DEPLOY_ADMIN,
  encodeFunctionData({
    abi: adapterImpl.abi,
    functionName: "initialize",
    args: [DEPLOY_ADMIN, predictedVaultProxy, CUSTODY_ADDRESS, TRUSTED_INBOUND_CALLER],
  }),
]);

const vaultInitData = encodeFunctionData({
  abi: vaultImpl.abi,
  functionName: "initialize",
  args: [DEPLOY_ADMIN, predictedAdapterProxy, L2_EXCHANGE_RECIPIENT],
});
const vaultProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
  vaultImpl.address,
  DEPLOY_ADMIN,
  vaultInitData,
]);

if (adapterProxy.address.toLowerCase() !== predictedAdapterProxy.toLowerCase()) {
  throw new Error("Adapter proxy address prediction mismatch");
}
if (vaultProxy.address.toLowerCase() !== predictedVaultProxy.toLowerCase()) {
  throw new Error("Vault proxy address prediction mismatch");
}

const strategyInitData = encodeFunctionData({
  abi: strategyImpl.abi,
  functionName: "initialize",
  args: [vaultProxy.address, AAVE_POOL, UNDERLYING_TOKEN, A_TOKEN, STRATEGY_NAME],
});
const strategyProxy = await viem.deployContract("TestTransparentUpgradeableProxy", [
  strategyImpl.address,
  DEPLOY_ADMIN,
  strategyInitData,
]);

console.log("Deployment complete:");
console.log(
  JSON.stringify(
    {
      network: networkName,
      admin: DEPLOY_ADMIN,
      vaultImplementation: vaultImpl.address,
      vaultProxy: vaultProxy.address,
      strategyImplementation: strategyImpl.address,
      strategyProxy: strategyProxy.address,
      adapterImplementation: adapterImpl.address,
      adapterProxy: adapterProxy.address,
      l2ExchangeRecipient: L2_EXCHANGE_RECIPIENT,
      custodyAddress: CUSTODY_ADDRESS,
      underlyingToken: UNDERLYING_TOKEN,
      aToken: A_TOKEN,
    },
    null,
    2,
  ),
);
