import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import JSON5 from "json5";
import { getAddress, isAddress, type Abi, type Hex } from "viem";

export type Address = `0x${string}`;

type TransparentUpgradeableProxyArtifact = {
  abi: Abi;
  bytecode: Hex;
};

const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

function cliArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

export function readParametersPath(): string {
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

export function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`invalid ${label}: expected address string`);
  }
  return getAddress(value);
}

export function parsePositiveBigint(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value <= 0n)
      throw new Error(`invalid ${label}: expected positive bigint`);
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
    let parsed: bigint;
    try {
      parsed = BigInt(normalized);
    } catch {
      throw new Error(`invalid ${label}: expected bigint-compatible value`);
    }
    if (parsed <= 0n)
      throw new Error(`invalid ${label}: expected positive bigint`);
    return parsed;
  }
  throw new Error(`invalid ${label}: expected bigint-compatible value`);
}

export function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid ${label}: expected non-empty string`);
  }
  return value;
}

export function readJson5Object(filePath: string): Record<string, unknown> {
  const parsed = JSON5.parse(readFileSync(filePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid parameters file shape");
  }
  return parsed as Record<string, unknown>;
}

export function readTransparentUpgradeableProxyArtifact(): TransparentUpgradeableProxyArtifact {
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

export async function readProxyAdminAddress(
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
