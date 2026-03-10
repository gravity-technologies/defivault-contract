import { network } from "hardhat";
import { encodeFunctionData, getAddress } from "viem";

import {
  parseAddress,
  parseNonEmptyString,
  readJson5Object,
  readParametersPath,
  readProxyAdminAddress,
  readTransparentUpgradeableProxyArtifact,
  type Address,
} from "./shared.js";

type StrategyDeployParams = {
  vaultProxy: Address;
  proxyAdminOwner: Address;
  aavePool: Address;
  underlyingToken: Address;
  aToken: Address;
  strategyName: string;
};

function readStrategyParameters(filePath: string): StrategyDeployParams {
  const raw = readJson5Object(filePath) as
    | { StrategyCoreModule?: Record<string, unknown> }
    | { StrategyCoreDeploy?: Record<string, unknown> }
    | { VaultTokenStrategyModule?: Record<string, unknown> }
    | Record<string, unknown>;

  let payload: Record<string, unknown> | undefined;
  if (typeof raw === "object" && raw !== null) {
    if (
      "StrategyCoreModule" in raw &&
      raw.StrategyCoreModule !== undefined &&
      raw.StrategyCoreModule !== null
    ) {
      payload = raw.StrategyCoreModule as Record<string, unknown>;
    } else if (
      "StrategyCoreDeploy" in raw &&
      raw.StrategyCoreDeploy !== undefined &&
      raw.StrategyCoreDeploy !== null
    ) {
      payload = raw.StrategyCoreDeploy as Record<string, unknown>;
    } else if (
      "VaultTokenStrategyModule" in raw &&
      raw.VaultTokenStrategyModule !== undefined &&
      raw.VaultTokenStrategyModule !== null
    ) {
      payload = raw.VaultTokenStrategyModule as Record<string, unknown>;
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
    strategyName: parseNonEmptyString(
      payload.strategyName ?? "AAVE_V3_UNDERLYING",
      "strategyName",
    ),
  };
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

  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(
      "strategy proxy deployment did not return a contract address",
    );
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
