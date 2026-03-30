import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { PublicClient, WalletClient } from "viem";
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import {
  makeRecordId,
  nowIso,
  operationRecordDir,
  operationRecordPath,
  readOperationRecord,
  repoRelativePath,
  type OperationKind,
  type OperationMode,
  type OperationRecord,
  writeOperationRecord,
} from "../../scripts/deploy/operation-records.js";
import { proxyAdminAbi, readProxyAdminAddress } from "./proxy-admin.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const strategyUpgradeProxyAdminAbi = parseAbi([
  "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
]);

type UpgradeContext = {
  environment: string;
  filePath: string;
  network: string;
  repoRoot: string;
};

type UpgradePreparationArgs = UpgradeContext & {
  callData: Hex;
  chainId: number;
  deploymentArtifacts?: Record<string, string>;
  forcePrepare?: boolean;
  implementation: Address;
  kind: OperationKind;
  longLivedAuthority: Address;
  proxy: Address;
  proxyAdmin: Address;
  proxyAdminOwner: Address;
  resolvedInputs: Record<string, unknown>;
  signer: Address;
  summary: string[];
};

type ConfirmUpgradeArgs = {
  chainId: number;
  kind: OperationKind;
  publicClient: PublicClient;
  recordPathOrDir: string;
  repoRoot: string;
  signer: Address;
  strategyKey?: string;
  txHash: Hex;
};

export type PreparedUpgrade = {
  implementation: Address;
  mode: OperationMode;
  proxyAdmin: Address;
  proxyAdminOwner: Address;
  recordDir: string;
  recordPath: string;
};

export function resolveDeploymentEnvironment(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = [
    "/tasks/parameters/",
    "/operations/parameters/",
    "/ignition/parameters/",
  ].find((candidate) => normalized.includes(candidate));
  if (marker === undefined) {
    throw new Error(
      `could not infer deployment environment from parameters path: ${filePath}`,
    );
  }
  const index = normalized.indexOf(marker);
  const rest = normalized.slice(index + marker.length);
  const [environment] = rest.split("/");
  if (environment === undefined || environment.length === 0) {
    throw new Error(
      `could not infer deployment environment from parameters path: ${filePath}`,
    );
  }
  return environment;
}

export function networkDisplayName(
  networkName: string,
  chainId?: number,
): string {
  if (networkName === "localhost") return "localhost";
  if (chainId === 1 || networkName === "mainnet") return "mainnet";
  if (chainId === 11155111 || networkName === "sepolia") return "sepolia";
  return networkName;
}

export async function readProxyImplementationAddress(
  publicClient: PublicClient,
  proxyAddress: Address,
): Promise<Address> {
  const raw = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });

  if (raw === undefined) {
    throw new Error("missing proxy implementation slot value");
  }

  const hex = raw.slice(2);
  return getAddress(`0x${hex.slice(24)}` as Address);
}

export function createUpgradeRecord(
  args: UpgradePreparationArgs,
): PreparedUpgrade {
  const recordId = makeRecordId();
  const recordDir = operationRecordDir({
    environment: args.environment,
    kind: args.kind,
    network: args.network,
    recordId,
    repoRoot: args.repoRoot,
  });

  const prepareMode =
    args.forcePrepare === true ||
    args.signer.toLowerCase() !== args.proxyAdminOwner.toLowerCase();
  const mode: OperationMode = prepareMode ? "prepare" : "direct";
  const status = prepareMode ? "awaiting_confirmation" : "prepared";
  const record: OperationRecord = {
    actor: {
      longLivedAuthority: args.longLivedAuthority,
      signer: args.signer,
    },
    chainId: args.chainId,
    createdAt: nowIso(),
    environment: args.environment,
    inputs: {
      parametersPath: repoRelativePath(args.repoRoot, args.filePath),
      ...args.resolvedInputs,
    },
    kind: args.kind,
    links:
      args.deploymentArtifacts === undefined
        ? undefined
        : Object.entries(args.deploymentArtifacts).map(([kind, path]) => ({
            kind,
            path,
          })),
    mode,
    network: args.network,
    outputs: {
      implementation: args.implementation,
      proxy: args.proxy,
      proxyAdmin: args.proxyAdmin,
      proxyAdminOwner: args.proxyAdminOwner,
      upgradeCalldata: args.callData,
    },
    recordId,
    schemaVersion: 1,
    status,
    summary: args.summary,
  };

  const recordPath = writeOperationRecord(recordDir, record);
  return {
    implementation: args.implementation,
    mode,
    proxyAdmin: args.proxyAdmin,
    proxyAdminOwner: args.proxyAdminOwner,
    recordDir,
    recordPath,
  };
}

export async function finalizeDirectUpgrade(args: {
  receipt: TransactionReceipt;
  recordDir: string;
  txHash: Hex;
}): Promise<void> {
  const record = readOperationRecord(args.recordDir);
  record.mode = "direct";
  record.status = "complete";
  record.outputs = {
    ...(record.outputs ?? {}),
    upgradeBlockNumber: args.receipt.blockNumber.toString(),
    upgradeStatus: args.receipt.status,
    upgradeTxHash: args.txHash,
  };
  writeOperationRecord(args.recordDir, record);
}

export async function confirmPreparedUpgrade(
  args: ConfirmUpgradeArgs,
): Promise<{ recordDir: string; recordPath: string }> {
  const prepared = readOperationRecord(args.recordPathOrDir);
  if (prepared.kind !== args.kind) {
    throw new Error(
      `record kind mismatch: expected ${args.kind}, found ${prepared.kind}`,
    );
  }
  if (prepared.mode !== "prepare") {
    throw new Error("only prepare records can be confirmed");
  }

  const proxy = getAddress(String(prepared.outputs?.proxy));
  const implementation = getAddress(String(prepared.outputs?.implementation));
  const receipt = await args.publicClient.waitForTransactionReceipt({
    hash: args.txHash,
  });
  const liveImplementation = await readProxyImplementationAddress(
    args.publicClient,
    proxy,
  );
  if (liveImplementation.toLowerCase() !== implementation.toLowerCase()) {
    throw new Error(
      `proxy ${proxy} still points to ${liveImplementation}, expected ${implementation}`,
    );
  }

  const confirmRecordId = makeRecordId();
  const confirmDir = operationRecordDir({
    environment: prepared.environment,
    kind: args.kind,
    network: prepared.network,
    recordId: confirmRecordId,
    repoRoot: args.repoRoot,
  });
  const confirmRecord: OperationRecord = {
    actor: {
      longLivedAuthority: prepared.actor.longLivedAuthority,
      signer: args.signer,
    },
    chainId: args.chainId,
    createdAt: nowIso(),
    environment: prepared.environment,
    inputs: prepared.inputs,
    kind: args.kind,
    links: [
      ...(prepared.links ?? []),
      {
        kind: "prepared-record",
        path: repoRelativePath(
          args.repoRoot,
          operationRecordPath(resolveRecordDir(args.recordPathOrDir)),
        ),
        recordId: prepared.recordId,
      },
    ],
    mode: "confirm",
    network: prepared.network,
    outputs: {
      ...(prepared.outputs ?? {}),
      confirmedImplementation: liveImplementation,
      upgradeBlockNumber: receipt.blockNumber.toString(),
      upgradeStatus: receipt.status,
      upgradeTxHash: args.txHash,
    },
    recordId: confirmRecordId,
    schemaVersion: 1,
    status: "complete",
    summary: [
      `# ${args.kind} confirmation`,
      "",
      `- Prepared record: \`${prepared.recordId}\``,
      `- Proxy: \`${proxy}\``,
      `- Implementation: \`${implementation}\``,
      `- Upgrade tx hash: \`${args.txHash}\``,
    ],
  };
  const confirmPath = writeOperationRecord(confirmDir, confirmRecord);
  return { recordDir: confirmDir, recordPath: confirmPath };
}

export async function executeProxyUpgrade(args: {
  implementation: Address;
  proxy: Address;
  proxyAdmin: Address;
  publicClient: PublicClient;
  upgradeCallData: Hex;
  walletClient: WalletClient;
}): Promise<{ receipt: TransactionReceipt; txHash: Hex }> {
  if (args.walletClient.account === undefined) {
    throw new Error("selected network has no configured signer");
  }
  const txHash = await args.walletClient.writeContract({
    address: args.proxyAdmin,
    abi: strategyUpgradeProxyAdminAbi,
    chain: args.walletClient.chain,
    functionName: "upgradeAndCall",
    args: [args.proxy, args.implementation, args.upgradeCallData],
    account: args.walletClient.account,
  });
  const receipt = await args.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  return { receipt, txHash };
}

export function encodeProxyUpgradeCalldata(args: {
  implementation: Address;
  proxy: Address;
  upgradeCallData: Hex;
}): Hex {
  return encodeFunctionData({
    abi: proxyAdminAbi,
    functionName: "upgradeAndCall",
    args: [args.proxy, args.implementation, args.upgradeCallData],
  });
}

export async function resolveProxyUpgradeContext(args: {
  hre: HardhatRuntimeEnvironment;
  filePath: string;
  proxy: Address;
  proxyAdmin?: Address;
  signer: Address;
}): Promise<
  UpgradeContext & {
    chainId: number;
    longLivedAuthority: Address;
    proxyAdmin: Address;
  }
> {
  const environment = resolveDeploymentEnvironment(args.filePath);
  const { viem } = await args.hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const network = networkDisplayName("unknown", chainId);
  const proxyAdmin =
    args.proxyAdmin ?? (await readProxyAdminAddress(publicClient, args.proxy));
  const proxyAdminOwner = await publicClient.readContract({
    address: proxyAdmin,
    abi: proxyAdminAbi,
    functionName: "owner",
  });

  return {
    chainId,
    environment,
    filePath: args.filePath,
    longLivedAuthority: getAddress(proxyAdminOwner),
    network,
    repoRoot: args.hre.config.paths.root,
    proxyAdmin,
  };
}

export function resolveRecordDir(recordPathOrDir: string): string {
  return recordPathOrDir.endsWith(".json")
    ? recordPathOrDir.slice(0, -"/record.json".length)
    : recordPathOrDir;
}
