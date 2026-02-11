import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import JSON5 from "json5";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, isAddress, type Abi, type Hex } from "viem";

type Address = `0x${string}`;

const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

type StrategyDeployParams = {
  vaultProxy: Address;
  proxyAdminOwner: Address;
  aavePool: Address;
  underlyingToken: Address;
  aToken: Address;
  strategyName: string;
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

function parseStrategyName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid strategyName: expected non-empty string");
  }
  return value;
}

function readStrategyParameters(filePath: string): StrategyDeployParams {
  const raw = JSON5.parse(readFileSync(filePath, "utf8")) as
    | { StrategyCoreDeploy?: Record<string, unknown> }
    | { TokenStrategyModule?: Record<string, unknown> }
    | Record<string, unknown>;

  let payload: Record<string, unknown> | undefined;
  if (typeof raw === "object" && raw !== null) {
    if (
      "StrategyCoreDeploy" in raw &&
      raw.StrategyCoreDeploy !== undefined &&
      raw.StrategyCoreDeploy !== null
    ) {
      payload = raw.StrategyCoreDeploy as Record<string, unknown>;
    } else if (
      "TokenStrategyModule" in raw &&
      raw.TokenStrategyModule !== undefined &&
      raw.TokenStrategyModule !== null
    ) {
      payload = raw.TokenStrategyModule as Record<string, unknown>;
    } else {
      payload = raw as Record<string, unknown>;
    }
  }

  if (payload === undefined || typeof payload !== "object") {
    throw new Error("invalid parameters file shape");
  }

  const proxyAdminOwnerRaw = payload.proxyAdminOwner ?? payload.proxyAdmin;

  return {
    vaultProxy: parseAddress(payload.vaultProxy, "vaultProxy"),
    proxyAdminOwner: parseAddress(proxyAdminOwnerRaw, "proxyAdminOwner"),
    aavePool: parseAddress(payload.aavePool, "aavePool"),
    underlyingToken: parseAddress(payload.underlyingToken, "underlyingToken"),
    aToken: parseAddress(payload.aToken, "aToken"),
    strategyName: parseStrategyName(payload.strategyName ?? "AAVE_V3_UNDERLYING"),
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
  const params = readStrategyParameters(paramsPath);
  const proxyArtifact = readTransparentUpgradeableProxyArtifact();

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  if (deployer.account === undefined) {
    throw new Error("deployer wallet account is undefined");
  }

  const strategyImplementation = await viem.deployContract("AaveV3Strategy");
  const initializeCalldata = encodeFunctionData({
    abi: strategyImplementation.abi,
    functionName: "initialize",
    args: [
      params.vaultProxy,
      params.aavePool,
      params.underlyingToken,
      params.aToken,
      params.strategyName,
    ],
  });

  const deployHash = await deployer.deployContract({
    account: deployer.account,
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode,
    args: [
      strategyImplementation.address,
      params.proxyAdminOwner,
      initializeCalldata,
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });

  if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
    throw new Error("strategy proxy deployment did not return a contract address");
  }

  const strategyProxy = getAddress(receipt.contractAddress);
  const proxyAdmin = await readProxyAdminAddress(
    {
      getStorageAt: (args) =>
        publicClient.getStorageAt({
          address: args.address,
          slot: args.slot,
        }),
    },
    strategyProxy,
  );

  const output = {
    network: await publicClient.getChainId(),
    strategyImplementation: strategyImplementation.address,
    strategyProxy,
    strategyProxyAdmin: proxyAdmin,
    deployTxHash: deployHash,
  };
  console.log(`DEPLOY_JSON=${JSON.stringify(output)}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
