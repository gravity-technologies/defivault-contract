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

type GhoStrategyDeployParams = {
  vaultProxy: Address;
  proxyAdminOwner: Address;
  vaultToken: Address;
  gho: Address;
  stkGho: Address;
  gsm: Address;
  stakingAdapter: Address;
  strategyName: string;
};

function readStrategyParameters(filePath: string): GhoStrategyDeployParams {
  const raw = readJson5Object(filePath) as
    | { GhoStrategyCoreModule?: Record<string, unknown> }
    | { GhoStrategyDeploy?: Record<string, unknown> }
    | Record<string, unknown>;

  let payload: Record<string, unknown> | undefined;
  if (typeof raw === "object" && raw !== null) {
    if (
      "GhoStrategyCoreModule" in raw &&
      raw.GhoStrategyCoreModule !== undefined &&
      raw.GhoStrategyCoreModule !== null
    ) {
      payload = raw.GhoStrategyCoreModule as Record<string, unknown>;
    } else if (
      "GhoStrategyDeploy" in raw &&
      raw.GhoStrategyDeploy !== undefined &&
      raw.GhoStrategyDeploy !== null
    ) {
      payload = raw.GhoStrategyDeploy as Record<string, unknown>;
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
    vaultToken: parseAddress(payload.vaultToken, "vaultToken"),
    gho: parseAddress(payload.gho, "gho"),
    stkGho: parseAddress(payload.stkGho, "stkGho"),
    gsm: parseAddress(payload.gsm, "gsm"),
    stakingAdapter: parseAddress(payload.stakingAdapter, "stakingAdapter"),
    strategyName: parseNonEmptyString(
      payload.strategyName ?? "GSM_STKGHO",
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

  const strategyImplementation = await viem.deployContract("GsmStkGhoStrategy");
  const initializeCalldata = encodeFunctionData({
    abi: strategyImplementation.abi,
    functionName: "initialize",
    args: [
      params.vaultProxy,
      params.vaultToken,
      params.gho,
      params.stkGho,
      params.gsm,
      params.stakingAdapter,
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
