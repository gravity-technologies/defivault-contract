import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import JSON5 from "json5";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, isAddress, type Abi, type Hex } from "viem";

type Address = `0x${string}`;

const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

type VaultCoreParams = {
  deployAdmin: Address;
  bridgeHub: Address;
  baseToken: Address;
  l2ChainId: bigint;
  l2ExchangeRecipient: Address;
  wrappedNativeToken: Address;
};

type TransparentUpgradeableProxyArtifact = {
  abi: Abi;
  bytecode: Hex;
};

function cliArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function readParametersPath(): string {
  const fromCli = cliArgValue("--parameters");
  if (fromCli !== undefined) return resolve(process.cwd(), fromCli);

  const fromEnv = process.env.DEPLOY_PARAMS_FILE;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolve(process.cwd(), fromEnv);
  }

  throw new Error(
    "missing deployment parameters file; pass --parameters <path> or set DEPLOY_PARAMS_FILE",
  );
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`invalid ${label}: expected address string`);
  }
  return getAddress(value);
}

function parseBigint(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`invalid ${label}: expected positive integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    const parsed = BigInt(normalized);
    if (parsed <= 0n) {
      throw new Error(`invalid ${label}: expected positive bigint`);
    }
    return parsed;
  }
  throw new Error(`invalid ${label}: expected bigint-compatible value`);
}

function readVaultCoreParameters(filePath: string): VaultCoreParams {
  const raw = JSON5.parse(readFileSync(filePath, "utf8")) as
    | { VaultCoreModule?: Record<string, unknown> }
    | Record<string, unknown>;

  const payload =
    typeof raw === "object" && raw !== null && "VaultCoreModule" in raw
      ? raw.VaultCoreModule
      : raw;

  if (typeof payload !== "object" || payload === null) {
    throw new Error("invalid parameters file shape");
  }
  const params = payload as Record<string, unknown>;

  return {
    deployAdmin: parseAddress(params.deployAdmin, "deployAdmin"),
    bridgeHub: parseAddress(params.bridgeHub, "bridgeHub"),
    baseToken: parseAddress(params.baseToken, "baseToken"),
    l2ChainId: parseBigint(params.l2ChainId, "l2ChainId"),
    l2ExchangeRecipient: parseAddress(
      params.l2ExchangeRecipient,
      "l2ExchangeRecipient",
    ),
    wrappedNativeToken: parseAddress(
      params.wrappedNativeToken,
      "wrappedNativeToken",
    ),
  };
}

function readTransparentUpgradeableProxyArtifact(): TransparentUpgradeableProxyArtifact {
  const artifactPath = resolve(
    process.cwd(),
    "node_modules/@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json",
  );
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    abi?: Abi;
    bytecode?: Hex;
  };
  if (parsed.abi === undefined || parsed.bytecode === undefined) {
    throw new Error("invalid TransparentUpgradeableProxy artifact");
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode };
}

async function readProxyAdminAddress(
  publicClient: {
    getStorageAt(args: {
      address: Address;
      slot: Hex;
    }): Promise<Hex | undefined>;
  },
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

async function main() {
  const paramsPath = readParametersPath();
  const params = readVaultCoreParameters(paramsPath);
  const proxyArtifact = readTransparentUpgradeableProxyArtifact();

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  if (deployer.account === undefined) {
    throw new Error("deployer wallet account is undefined");
  }

  const vaultImplementation = await viem.deployContract("GRVTDeFiVault");
  const initializeCalldata = encodeFunctionData({
    abi: vaultImplementation.abi,
    functionName: "initialize",
    args: [
      params.deployAdmin,
      params.bridgeHub,
      params.baseToken,
      params.l2ChainId,
      params.l2ExchangeRecipient,
      params.wrappedNativeToken,
    ],
  });

  const deployHash = await deployer.deployContract({
    account: deployer.account,
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode,
    args: [vaultImplementation.address, params.deployAdmin, initializeCalldata],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });

  if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
    throw new Error("vault proxy deployment did not return a contract address");
  }

  const vaultProxy = getAddress(receipt.contractAddress);
  const proxyAdmin = await readProxyAdminAddress(
    {
      getStorageAt: (args) =>
        publicClient.getStorageAt({
          address: args.address,
          slot: args.slot,
        }),
    },
    vaultProxy,
  );

  const output = {
    network: await publicClient.getChainId(),
    vaultImplementation: vaultImplementation.address,
    vaultProxy,
    vaultProxyAdmin: proxyAdmin,
    deployTxHash: deployHash,
  };
  console.log(`DEPLOY_JSON=${JSON.stringify(output)}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
