import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import JSON5 from "json5";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import {
  makeRecordId,
  nowIso,
  operationRecordDir,
  readOperationRecord,
  repoRelativePath,
  resolveCurrentDeploymentState,
  writeOperationRecord,
  type CurrentDeploymentState,
  type OperationKind,
  type OperationRecord,
} from "../../scripts/deploy/operation-records.js";

export type JsonRecord = Record<string, unknown>;

type OneOffRecordContext = {
  chainId: number;
  currentDeployment?: CurrentDeploymentState;
  environment: string;
  network: string;
  repoRoot: string;
};

type DirectOperationRecordArgs = {
  context: OneOffRecordContext;
  filePath: string;
  kind: OperationKind;
  longLivedAuthority?: Address;
  outputs?: Record<string, unknown>;
  resolvedInputs: Record<string, unknown>;
  signer: Address;
  stepLabel: string;
  summary: string[];
};

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ZKSYNC_NATIVE_TOKEN =
  "0x0000000000000000000000000000000000000001" as const;

export const vaultAbi = parseAbi([
  "function allocateVaultTokenToStrategy(address token,address strategy,uint256 amount)",
  "function deallocateVaultTokenFromStrategy(address token,address strategy,uint256 amount) returns (uint256 received)",
  "function deallocateAllVaultTokenFromStrategy(address token,address strategy) returns (uint256 received)",
  "function harvestYieldFromStrategy(address token,address strategy,uint256 amount,uint256 minReceived)",
  "function setYieldRecipient(address newYieldRecipient)",
]);
export const timelockAbi = parseAbi([
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt)",
]);
export const nativeBridgeGatewayAbi = parseAbi([
  "function claimAndRecoverFailedNativeDeposit(bytes32 bridgeTxHash,uint256 l2BatchNumber,uint256 l2MessageIndex,uint16 l2TxNumberInBatch,bytes32[] merkleProof)",
]);

export function readModuleParams(
  filePath: string,
  moduleKey: string,
): JsonRecord {
  const parsed = JSON5.parse(readFileSync(filePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid JSON5 object: ${filePath}`);
  }

  const params = (parsed as JsonRecord)[moduleKey];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(`missing or invalid ${moduleKey} in ${filePath}`);
  }
  return params as JsonRecord;
}

export function requireString(
  params: JsonRecord,
  key: string,
  filePath: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing or invalid ${key} in ${filePath}`);
  }
  return value;
}

export function requireBoolean(
  params: JsonRecord,
  key: string,
  filePath: string,
): boolean {
  const value = params[key];
  if (typeof value !== "boolean") {
    throw new Error(`missing or invalid ${key} in ${filePath}`);
  }
  return value;
}

export function requireAddress(
  params: JsonRecord,
  key: string,
  filePath: string,
): Address {
  const value = requireString(params, key, filePath);
  if (!isAddress(value)) {
    throw new Error(`invalid address for ${key} in ${filePath}`);
  }
  return getAddress(value);
}

export function requireBytes32(
  params: JsonRecord,
  key: string,
  filePath: string,
): Hex {
  const value = requireString(params, key, filePath);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid bytes32 for ${key} in ${filePath}`);
  }
  return value as Hex;
}

export function requireHexData(
  params: JsonRecord,
  key: string,
  filePath: string,
): Hex {
  const value = requireString(params, key, filePath);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`invalid hex data for ${key} in ${filePath}`);
  }
  return value as Hex;
}

export function parseBigintLike(
  value: unknown,
  label: string,
  filePath: string,
): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string") {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    return BigInt(normalized);
  }
  throw new Error(`missing or invalid ${label} in ${filePath}`);
}

export function requireUint(
  params: JsonRecord,
  key: string,
  filePath: string,
): bigint {
  return parseBigintLike(params[key], key, filePath);
}

export function requireUint16(
  params: JsonRecord,
  key: string,
  filePath: string,
): number {
  const value = parseBigintLike(params[key], key, filePath);
  if (value < 0n || value > 65535n) {
    throw new Error(`invalid uint16 for ${key} in ${filePath}`);
  }
  return Number(value);
}

export function requireBytes32Array(
  params: JsonRecord,
  key: string,
  filePath: string,
): Hex[] {
  const value = params[key];
  if (!Array.isArray(value)) {
    throw new Error(`missing or invalid ${key} in ${filePath}`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry)) {
      throw new Error(`invalid bytes32 at ${key}[${index}] in ${filePath}`);
    }
    return entry as Hex;
  });
}

export async function getClients(hre: HardhatRuntimeEnvironment) {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const walletClients = await viem.getWalletClients();
  if (walletClients.length === 0 || walletClients[0].account === undefined) {
    throw new Error("selected network has no configured signer");
  }
  return { viem, publicClient, walletClient: walletClients[0] };
}

export function resolveParametersPath(parameters: string | undefined): string {
  if (parameters === undefined) {
    throw new Error("missing required --parameters <file>");
  }
  return resolve(process.cwd(), parameters);
}

export function encodeSetYieldRecipient(newYieldRecipient: Address): Hex {
  return encodeFunctionData({
    abi: vaultAbi,
    functionName: "setYieldRecipient",
    args: [newYieldRecipient],
  });
}

function resolveDeploymentEnvironment(filePath: string): string {
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

function networkDisplayName(networkName: string, chainId?: number): string {
  if (networkName === "localhost") return "localhost";
  if (chainId === 1 || networkName === "mainnet") return "mainnet";
  if (chainId === 11155111 || networkName === "sepolia") return "sepolia";
  return networkName;
}

function buildRecordLinks(
  currentDeployment: CurrentDeploymentState | undefined,
): Array<{ kind: string; path?: string; recordId?: string }> | undefined {
  if (currentDeployment === undefined) {
    return undefined;
  }

  return [
    {
      kind: "initial-stack-record",
      path: currentDeployment.initialStackRecordPath,
      recordId: currentDeployment.initialStackRecordId,
    },
    ...(currentDeployment.cutoffRecordId === undefined
      ? []
      : [
          {
            kind: "cutoff-record",
            path: currentDeployment.cutoffRecordPath,
            recordId: currentDeployment.cutoffRecordId,
          },
        ]),
  ];
}

export async function resolveOneOffRecordContext(args: {
  filePath: string;
  hre: HardhatRuntimeEnvironment;
}): Promise<OneOffRecordContext> {
  const environment = resolveDeploymentEnvironment(args.filePath);
  const { viem } = await args.hre.network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const network = networkDisplayName(
    args.hre.globalOptions.network ?? "unknown",
    chainId,
  );
  const repoRoot = args.hre.config.paths.root;

  let currentDeployment: CurrentDeploymentState | undefined;
  try {
    currentDeployment = resolveCurrentDeploymentState({
      environment,
      network,
      repoRoot,
    });
  } catch {
    currentDeployment = undefined;
  }

  return {
    chainId,
    currentDeployment,
    environment,
    network,
    repoRoot,
  };
}

export function resolveRecordAuthority(args: {
  currentDeployment?: CurrentDeploymentState;
  nativeBridgeGatewayProxy?: Address;
  timelockController?: Address;
  vaultProxy?: Address;
}): Address | undefined {
  const { currentDeployment } = args;
  if (currentDeployment === undefined) {
    return undefined;
  }

  if (
    args.vaultProxy !== undefined &&
    currentDeployment.vault !== undefined &&
    currentDeployment.vault.proxy.toLowerCase() ===
      args.vaultProxy.toLowerCase()
  ) {
    return getAddress(currentDeployment.vault.deployAdmin);
  }

  if (
    args.timelockController !== undefined &&
    currentDeployment.yieldRecipientTimelock?.controller.toLowerCase() ===
      args.timelockController.toLowerCase()
  ) {
    return getAddress(currentDeployment.yieldRecipientTimelock.controller);
  }

  if (
    args.nativeBridgeGatewayProxy !== undefined &&
    currentDeployment.nativeBridge?.proxy.toLowerCase() ===
      args.nativeBridgeGatewayProxy.toLowerCase()
  ) {
    return getAddress(
      currentDeployment.vault?.deployAdmin ??
        currentDeployment.nativeBridge.proxyAdminOwner,
    );
  }

  return undefined;
}

export function createDirectOperationRecord(args: DirectOperationRecordArgs): {
  recordDir: string;
  recordPath: string;
} {
  const createdAt = nowIso();
  const recordId = makeRecordId();
  const recordDir = operationRecordDir({
    environment: args.context.environment,
    kind: args.kind,
    network: args.context.network,
    recordId,
    repoRoot: args.context.repoRoot,
  });
  const record: OperationRecord = {
    actor: {
      longLivedAuthority: args.longLivedAuthority,
      signer: args.signer,
    },
    chainId: args.context.chainId,
    createdAt,
    environment: args.context.environment,
    inputs: {
      parametersPath: repoRelativePath(args.context.repoRoot, args.filePath),
      ...args.resolvedInputs,
    },
    kind: args.kind,
    links: buildRecordLinks(args.context.currentDeployment),
    mode: "direct",
    network: args.context.network,
    outputs: args.outputs,
    recordId,
    schemaVersion: 1,
    status: "prepared",
    steps: [
      {
        label: args.stepLabel,
        startedAt: createdAt,
        status: "prepared",
      },
    ],
    summary: args.summary,
  };

  return {
    recordDir,
    recordPath: writeOperationRecord(recordDir, record),
  };
}

export function finalizeDirectOperationRecord(args: {
  outputs?: Record<string, unknown>;
  receipt: TransactionReceipt;
  recordDir: string;
  txHash: Hex;
}): void {
  const record = readOperationRecord(args.recordDir);
  const completedAt = nowIso();
  record.status = "complete";
  record.outputs = {
    ...(record.outputs ?? {}),
    ...(args.outputs ?? {}),
    blockNumber: args.receipt.blockNumber.toString(),
    status: args.receipt.status,
    txHash: args.txHash,
  };
  record.steps = (record.steps ?? []).map((step, index) =>
    index === 0
      ? {
          ...step,
          completedAt,
          status: "complete",
          txHashes: [args.txHash],
        }
      : step,
  );
  writeOperationRecord(args.recordDir, record);
}
