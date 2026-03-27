import { network } from "hardhat";
import { encodeFunctionData, getAddress } from "viem";

import {
  parseAddress,
  parsePositiveBigint,
  readJson5Object,
  readParametersPath,
  readProxyAdminAddress,
  readTransparentUpgradeableProxyArtifact,
  type Address,
} from "./shared.js";

type VaultCoreParams = {
  deployAdmin: Address;
  bridgeHub: Address;
  grvtBridgeProxyFeeToken: Address;
  l2ChainId: bigint;
  l2ExchangeRecipient: Address;
  wrappedNativeToken: Address;
  yieldRecipient: Address;
};

function readVaultCoreParameters(filePath: string): VaultCoreParams {
  const raw = readJson5Object(filePath) as
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
    grvtBridgeProxyFeeToken: parseAddress(
      params.grvtBridgeProxyFeeToken,
      "grvtBridgeProxyFeeToken",
    ),
    l2ChainId: parsePositiveBigint(params.l2ChainId, "l2ChainId"),
    l2ExchangeRecipient: parseAddress(
      params.l2ExchangeRecipient,
      "l2ExchangeRecipient",
    ),
    wrappedNativeToken: parseAddress(
      params.wrappedNativeToken,
      "wrappedNativeToken",
    ),
    yieldRecipient: parseAddress(params.yieldRecipient, "yieldRecipient"),
  };
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

  const yieldRecipientCode = await publicClient.getCode({
    address: params.yieldRecipient,
  });
  if (yieldRecipientCode === undefined || yieldRecipientCode === "0x") {
    throw new Error("yieldRecipient must be a contract address");
  }

  const vaultStrategyOpsLib = await viem.deployContract("VaultStrategyOpsLib");
  const vaultBridgeLib = await viem.deployContract("VaultBridgeLib");
  const libraries = {
    VaultStrategyOpsLib: vaultStrategyOpsLib.address,
    VaultBridgeLib: vaultBridgeLib.address,
  } as const;
  const vaultImplementation = await viem.deployContract(
    "GRVTL1TreasuryVault",
    [],
    { libraries },
  );
  const initializeCalldata = encodeFunctionData({
    abi: vaultImplementation.abi,
    functionName: "initialize",
    args: [
      params.deployAdmin,
      params.bridgeHub,
      params.grvtBridgeProxyFeeToken,
      params.l2ChainId,
      params.l2ExchangeRecipient,
      params.wrappedNativeToken,
      params.yieldRecipient,
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

  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
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
    vaultStrategyOpsLib: vaultStrategyOpsLib.address,
    vaultBridgeLib: vaultBridgeLib.address,
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
