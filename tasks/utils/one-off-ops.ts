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
} from "viem";

export type JsonRecord = Record<string, unknown>;

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ZKSYNC_NATIVE_TOKEN =
  "0x0000000000000000000000000000000000000001" as const;

export const vaultAbi = parseAbi([
  "function harvestYieldFromStrategy(address token,address strategy,uint256 amount,uint256 minReceived)",
  "function setYieldRecipient(address newYieldRecipient)",
]);
export const timelockAbi = parseAbi([
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt)",
]);
export const sharedBridgeAbi = parseAbi([
  "function claimFailedDeposit(uint256 chainId,address depositSender,address l1Token,uint256 amount,bytes32 l2TxHash,uint256 l2BatchNumber,uint256 l2MessageIndex,uint16 l2TxNumberInBatch,bytes32[] merkleProof)",
]);
export const nativeBridgeGatewayAbi = parseAbi([
  "function recoverClaimedNativeDeposit(bytes32 bridgeTxHash)",
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
