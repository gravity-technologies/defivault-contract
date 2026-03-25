import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";

import chalk from "chalk";
import { network } from "hardhat";
import JSON5 from "json5";
import * as emoji from "node-emoji";
import ora from "ora";
import { initialStackRunDir } from "./initial-stack-artifacts.js";
import {
  OPERATION_RECORD_SCHEMA_VERSION,
  writeOperationRecord,
  type OperationRecord,
  type OperationStatus,
  type OperationStep,
} from "./operation-records.js";
import {
  formatEther,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * Interactive initial DefiVault stack deployment entrypoint.
 *
 * Role:
 * - Orchestrates the first full deployment of a DefiVault environment from an
 *   operator terminal.
 * - Collects or derives environment-specific parameters, stages temporary
 *   parameter files, and then executes the repo's Ignition modules in a
 *   controlled step-by-step order.
 * - Persists a final canonical `record.json` plus any failure logs under
 *   `deployment-records/` once the deployment phase completes.
 *
 * Scope:
 * - Intended for greenfield stack deployment flows across localhost and remote
 *   environments.
 * - Non-production GRVT environments (`staging`, `testnet`, and localhost
 *   smoke flows) deploy a MockAaveV3Pool/MockAaveV3AToken pair around an
 *   operator-supplied underlying token instead of depending on a public Aave
 *   reserve.
 * - Production uses the live Aave pool/aToken addresses configured in
 *   `ignition/parameters/production/strategy-core.json5` and validates them
 *   instead of deploying mocks.
 * - Deploys or wires the Aave prerequisites, vault core, strategy core, vault
 *   token support, strategy binding, roles, yield recipient timelock, and
 *   native gateways.
 * - Reuses local prerequisite values in local mode instead of asking the
 *   operator for those values again.
 *
 * Non-goals:
 * - This is not the upgrade path for an existing stack.
 * - This is not the general-purpose ops console for ad hoc configuration
 *   changes after deployment.
 *
 * Design constraints:
 * - Source parameter files under `ignition/parameters/` remain untouched. This
 *   script only stages temporary params outside `deployment-records`.
 * - Each major step is explicitly confirmed by the operator before execution.
 * - Deployment state is delegated to Ignition wherever possible so the flow is
 *   deterministic and easier to reason about than ad hoc transaction scripts.
 */
type JsonRecord = Record<string, unknown>;
type GrvtEnvironment = "staging" | "testnet" | "production";
type AaveMode = "mock-aave" | "live-aave";

type CommandResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

type StepStatus = "pending" | "completed" | "aborted";

type StepRecord = {
  addresses?: Record<string, string>;
  command?: string;
  completedAt?: string;
  duration?: string;
  logFiles?: { stderr: string; stdout: string };
  name: string;
  nextAction?: string;
  notes?: string[];
  startedAt: string;
  status: StepStatus;
};

type DeploymentManifest = {
  artifactsDir: string;
  createdAt: string;
  environment: {
    aaveMode: AaveMode;
    grvtEnv: GrvtEnvironment;
    localMode: boolean;
    parameterDir: string;
    repeatStepConfirmations: boolean;
    runPostDeployVerification: boolean;
  };
  network: {
    alias: string;
    chainId: number;
    deployer: Address;
    name: string;
  };
  resolvedParams: Record<string, unknown>;
  runId: string;
  sourceParameterFiles: Record<string, string>;
  steps: StepRecord[];
};

type VaultCoreParams = {
  bridgeHub: Address;
  deployAdmin: Address;
  finalVaultAdmin?: Address;
  grvtBridgeProxyFeeToken: Address;
  l2ChainId: bigint;
  l2ExchangeRecipient: Address;
  wrappedNativeToken: Address;
  yieldRecipient: Address;
};

type StrategyCoreParams = {
  aToken?: Address;
  aavePool?: Address;
  proxyAdminOwner: Address;
  strategyName: string;
  underlyingToken: Address;
  vaultProxy?: Address;
};

type VaultTokenConfigParams = {
  supported: boolean;
  vaultProxy?: Address;
  vaultToken?: Address;
};

type VaultTokenStrategyParams = {
  strategyCap: bigint;
  strategyProxy?: Address;
  vaultProxy?: Address;
  vaultToken?: Address;
  vaultTokenStrategyWhitelisted: boolean;
  vaultTokenSupported: boolean;
};

type RolesBootstrapParams = {
  allocator: Address;
  pauser: Address;
  rebalancer: Address;
  vaultProxy?: Address;
};

type YieldRecipientBootstrapParams = {
  admin: Address;
  executors: Address[];
  minDelay: bigint;
  proposers: Address[];
  vaultProxy?: Address;
};

type NativeGatewaysParams = {
  bridgeHub: Address;
  grvtBridgeProxyFeeToken: Address;
  proxyAdminOwner: Address;
  vaultProxy?: Address;
  wrappedNativeToken: Address;
};

type ResolvedParams = {
  aTokenName: string;
  aTokenSymbol: string;
  productionAuthorityPlan?: {
    bootstrapVaultAdmin: Address;
    finalVaultAdmin: Address;
  };
  nativeGateways: NativeGatewaysParams;
  rolesBootstrap: RolesBootstrapParams;
  strategyCore: StrategyCoreParams;
  vaultCore: VaultCoreParams;
  vaultTokenConfig: VaultTokenConfigParams;
  vaultTokenStrategy: VaultTokenStrategyParams;
  yieldRecipientBootstrap: YieldRecipientBootstrapParams;
};

type LocalSmokePrerequisites = {
  aToken: Address;
  aavePool: Address;
  allocator: Address;
  bridgeHub: Address;
  deployAdmin: Address;
  grvtBridgeProxyFeeToken: Address;
  l2ChainId: bigint;
  l2ExchangeRecipient: Address;
  pauser: Address;
  rebalancer: Address;
  strategyCap: bigint;
  strategyName: string;
  underlyingToken: Address;
  wrappedNativeToken: Address;
  yieldRecipient: Address;
};

type ParameterSources = {
  nativeGatewaysSource: JsonRecord;
  rolesSource: JsonRecord;
  strategyCoreSource: JsonRecord;
  timelockSource: JsonRecord;
  vaultCoreSource: JsonRecord;
  vaultTokenConfigSource: JsonRecord;
  vaultTokenStrategySource: JsonRecord;
};

type OperatorDefaults = {
  allocator: Address;
  nativeProxyAdminOwner: Address;
  pauser: Address;
  rebalancer: Address;
  strategyProxyAdminOwner: Address;
};

type SupportFlags = {
  supported: boolean;
  whitelisted: boolean;
};

type TimelockDefaults = {
  admin: Address;
  executors: Address[];
  minDelay: bigint;
  proposers: Address[];
};

type ReadonlyContractMetadata = {
  decimals?: number;
  name?: string;
  symbol?: string;
};

type StrategyPrerequisiteSelections = {
  aToken?: Address;
  aavePool?: Address;
  aTokenName: string;
  aTokenSymbol: string;
  strategyName: string;
  underlyingToken: Address;
};

type ProxyAdminOwners = {
  nativeProxyAdminOwner: Address;
  strategyProxyAdminOwner: Address;
};

type RoleAndTimelockSelections = {
  admin: Address;
  allocator: Address;
  executors: Address[];
  minDelay: bigint;
  pauser: Address;
  proposers: Address[];
  rebalancer: Address;
};

const ERC20_METADATA_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const MOCK_AAVE_POOL_ABI = parseAbi([
  "function aToken() view returns (address)",
]);
const MOCK_AAVE_ATOKEN_ABI = parseAbi([
  "function POOL() view returns (address)",
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
]);
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;
const GRVT_ENVIRONMENTS = ["staging", "testnet", "production"] as const;
const TOTAL_STEPS = 8;

const repoRoot = process.cwd();
const parameterEnvironmentsRoot = resolve(repoRoot, "ignition/parameters");
const smokePrerequisitesPath = resolve(
  repoRoot,
  "smoke-artifacts/outputs/prerequisites.json",
);
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

class UserAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAbortError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson5Object(filePath: string): JsonRecord {
  const parsed = JSON5.parse(readFileSync(filePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid JSON5 object in ${relativePath(filePath)}`);
  }
  return parsed as JsonRecord;
}

function makeRunId(): string {
  const username = userInfo().username.replace(/[^A-Za-z0-9._-]/g, "-");
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}-${hours}${minutes}${seconds}Z-initial-stack-${username}`;
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, payload: unknown) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeJson5(path: string, payload: unknown) {
  writeJson(path, payload);
}

function normalizeAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`invalid address: ${value}`);
  return getAddress(value);
}

function sameAddress(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    isAddress(left) &&
    isAddress(right) &&
    getAddress(left) === getAddress(right)
  );
}

function isZeroAddress(value: string | undefined): boolean {
  return (
    value === undefined || !isAddress(value) || sameAddress(value, zeroAddress)
  );
}

function parseBigintLike(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value))
    return BigInt(value);
  if (typeof value === "string") {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    return BigInt(normalized);
  }
  throw new Error(`invalid ${label}: expected bigint-compatible value`);
}

function bigintText(value: bigint): string {
  return `${value}n`;
}

function strategyCapText(value: bigint): string {
  return value === 0n ? "Unlimited" : bigintText(value);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function relativePath(path: string): string {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function parseGrvtEnvironment(
  value: string,
  sourceLabel: string,
): GrvtEnvironment {
  if ((GRVT_ENVIRONMENTS as readonly string[]).includes(value)) {
    return value as GrvtEnvironment;
  }
  throw new Error(
    `invalid ${sourceLabel}: expected one of ${GRVT_ENVIRONMENTS.join(", ")}`,
  );
}

function environmentLabel(grvtEnvironment: GrvtEnvironment): string {
  return grvtEnvironment[0].toUpperCase() + grvtEnvironment.slice(1);
}

function aaveModeForEnvironment(grvtEnvironment: GrvtEnvironment): AaveMode {
  return grvtEnvironment === "production" ? "live-aave" : "mock-aave";
}

function aaveModeLabel(aaveMode: AaveMode): string {
  return aaveMode === "mock-aave" ? "Mock Aave" : "Live Aave";
}

function parameterDirForEnvironment(grvtEnvironment: GrvtEnvironment): string {
  return resolve(parameterEnvironmentsRoot, grvtEnvironment);
}

function sourcePath(parameterDir: string, fileName: string): string {
  return resolve(parameterDir, fileName);
}

function cliArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function runtimeNetworkName(): string {
  return cliArgValue("--network") ?? "sepolia";
}

function networkDisplayName(networkName: string, chainId?: number): string {
  if (networkName === "localhost") return "localhost";
  if (chainId === 1 || networkName === "mainnet") return "mainnet";
  if (chainId === 11155111 || networkName === "sepolia") return "sepolia";
  return networkName;
}

function isLocalMode(networkName: string): boolean {
  return networkName === "localhost";
}

function stepLabel(index: number, title: string): string {
  return `Step ${index}/${TOTAL_STEPS}: ${title}`;
}

function requireString(
  value: unknown,
  label: string,
  filePath: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing or invalid ${label} in ${relativePath(filePath)}`);
  }
  return value;
}

function readObjectRecord(
  value: unknown,
  key: string,
  filePath: string,
): JsonRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `invalid parameters file shape for ${key} in ${relativePath(filePath)}`,
    );
  }
  return value as JsonRecord;
}

function readModuleObject(filePath: string, key: string): JsonRecord {
  const parsed = readJson5Object(filePath);
  return readObjectRecord(parsed[key], key, filePath);
}

function readCoreModuleObject(
  parameterDir: string,
  key: "NativeGatewaysModule" | "VaultCoreModule",
) {
  const filePath = sourcePath(parameterDir, "core.json5");
  const parsed = readJson5Object(filePath);
  const globals = readObjectRecord(parsed.$global, "$global", filePath);
  const moduleRecord = readObjectRecord(parsed[key], key, filePath);
  return {
    ...globals,
    ...moduleRecord,
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalAddress(value: unknown): Address | undefined {
  const text = asOptionalString(value);
  return text === undefined || isZeroAddress(text)
    ? undefined
    : normalizeAddress(text);
}

function defaultAddressValue(
  value: unknown,
  fallback?: Address,
): Address | undefined {
  return optionalAddress(value) ?? fallback;
}

function defaultAddressArrayValue(
  value: unknown,
  fallback: Address[],
): Address[] {
  const parsed = asAddressArray(value);
  if (
    parsed === undefined ||
    parsed.every((address) => sameAddress(address, zeroAddress))
  ) {
    return fallback;
  }
  return parsed;
}

function loadParameterSources(parameterDir: string): ParameterSources {
  return {
    nativeGatewaysSource: readCoreModuleObject(
      parameterDir,
      "NativeGatewaysModule",
    ),
    rolesSource: readModuleObject(
      sourcePath(parameterDir, "roles-bootstrap.json5"),
      "VaultRolesBootstrapModule",
    ),
    strategyCoreSource: readModuleObject(
      sourcePath(parameterDir, "strategy-core.json5"),
      "StrategyCoreModule",
    ),
    timelockSource: readModuleObject(
      sourcePath(parameterDir, "yield-recipient-bootstrap.json5"),
      "VaultYieldRecipientTimelockModule",
    ),
    vaultCoreSource: readCoreModuleObject(parameterDir, "VaultCoreModule"),
    vaultTokenConfigSource: readModuleObject(
      sourcePath(parameterDir, "vault-token-config.json5"),
      "VaultTokenConfigModule",
    ),
    vaultTokenStrategySource: readModuleObject(
      sourcePath(parameterDir, "vault-token-strategy.json5"),
      "VaultTokenStrategyModule",
    ),
  };
}

function resolveOperatorDefaults(
  sources: ParameterSources,
  defaultAuthority: Address,
): OperatorDefaults {
  return {
    allocator:
      defaultAddressValue(sources.rolesSource.allocator, defaultAuthority) ??
      defaultAuthority,
    nativeProxyAdminOwner:
      defaultAddressValue(
        sources.nativeGatewaysSource.proxyAdminOwner,
        defaultAuthority,
      ) ?? defaultAuthority,
    pauser:
      defaultAddressValue(sources.rolesSource.pauser, defaultAuthority) ??
      defaultAuthority,
    rebalancer:
      defaultAddressValue(sources.rolesSource.rebalancer, defaultAuthority) ??
      defaultAuthority,
    strategyProxyAdminOwner:
      defaultAddressValue(
        sources.strategyCoreSource.proxyAdminOwner,
        defaultAuthority,
      ) ?? defaultAuthority,
  };
}

function resolveSupportFlags(sources: ParameterSources): SupportFlags {
  return {
    supported:
      asOptionalBoolean(sources.vaultTokenConfigSource.supported) ??
      asOptionalBoolean(sources.vaultTokenStrategySource.vaultTokenSupported) ??
      true,
    whitelisted:
      asOptionalBoolean(
        sources.vaultTokenStrategySource.vaultTokenStrategyWhitelisted,
      ) ?? true,
  };
}

function resolveTimelockDefaults(
  timelockSource: JsonRecord,
  defaultAuthority: Address,
): TimelockDefaults {
  return {
    admin:
      defaultAddressValue(timelockSource.admin, defaultAuthority) ??
      defaultAuthority,
    executors: defaultAddressArrayValue(timelockSource.executors, [
      defaultAuthority,
    ]),
    minDelay: parseBigintLike(timelockSource.minDelay ?? "86400n", "minDelay"),
    proposers: defaultAddressArrayValue(timelockSource.proposers, [
      defaultAuthority,
    ]),
  };
}

function renderTokenMetadataSummary(metadata: ReadonlyContractMetadata) {
  console.log(
    chalk.dim(
      [
        `${emoji.get("label")} underlying token metadata`,
        metadata.name !== undefined ? `name=${metadata.name}` : undefined,
        metadata.symbol !== undefined ? `symbol=${metadata.symbol}` : undefined,
        metadata.decimals !== undefined
          ? `decimals=${metadata.decimals}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  );
}

function defaultATokenName(
  metadata: ReadonlyContractMetadata,
  grvtEnvironment: GrvtEnvironment,
): string {
  return `Aave Mock ${environmentLabel(grvtEnvironment)} ${metadata.symbol ?? "Underlying"}`;
}

function defaultATokenSymbol(metadata: ReadonlyContractMetadata): string {
  return `am${metadata.symbol ?? "TOKEN"}`;
}

function defaultStrategyName(
  strategyCoreSource: JsonRecord,
  metadata: ReadonlyContractMetadata,
  grvtEnvironment: GrvtEnvironment,
  aaveMode: AaveMode,
): string {
  return (
    asOptionalString(strategyCoreSource.strategyName) ??
    (aaveMode === "mock-aave"
      ? `AAVE_V3_MOCK_${(metadata.symbol ?? "TOKEN").toUpperCase()}_${grvtEnvironment.toUpperCase()}`
      : `AAVE_V3_${(metadata.symbol ?? "TOKEN").toUpperCase()}_${grvtEnvironment.toUpperCase()}`)
  );
}

function readLocalSmokePrerequisites(
  filePath: string,
): LocalSmokePrerequisites {
  if (!existsSync(filePath)) {
    throw new Error(
      `local mode requires ${relativePath(filePath)} with prerequisite addresses`,
    );
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid JSON object in ${relativePath(filePath)}`);
  }

  const prereqs = parsed as JsonRecord;
  return {
    aToken: normalizeAddress(requireString(prereqs.aToken, "aToken", filePath)),
    aavePool: normalizeAddress(
      requireString(prereqs.aavePool, "aavePool", filePath),
    ),
    allocator: normalizeAddress(
      requireString(prereqs.allocator, "allocator", filePath),
    ),
    bridgeHub: normalizeAddress(
      requireString(prereqs.bridgeHub, "bridgeHub", filePath),
    ),
    deployAdmin: normalizeAddress(
      requireString(prereqs.deployAdmin, "deployAdmin", filePath),
    ),
    grvtBridgeProxyFeeToken: normalizeAddress(
      requireString(
        prereqs.grvtBridgeProxyFeeToken,
        "grvtBridgeProxyFeeToken",
        filePath,
      ),
    ),
    l2ChainId: parseBigintLike(prereqs.l2ChainId, "l2ChainId"),
    l2ExchangeRecipient: normalizeAddress(
      requireString(
        prereqs.l2ExchangeRecipient,
        "l2ExchangeRecipient",
        filePath,
      ),
    ),
    pauser: normalizeAddress(requireString(prereqs.pauser, "pauser", filePath)),
    rebalancer: normalizeAddress(
      requireString(prereqs.rebalancer, "rebalancer", filePath),
    ),
    strategyCap: parseBigintLike(prereqs.strategyCap, "strategyCap"),
    strategyName: requireString(prereqs.strategyName, "strategyName", filePath),
    underlyingToken: normalizeAddress(
      requireString(prereqs.underlyingToken, "underlyingToken", filePath),
    ),
    wrappedNativeToken: normalizeAddress(
      requireString(prereqs.wrappedNativeToken, "wrappedNativeToken", filePath),
    ),
    yieldRecipient: normalizeAddress(
      requireString(prereqs.yieldRecipient, "yieldRecipient", filePath),
    ),
  };
}

function asAddressArray(value: unknown): Address[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("expected address array");
    }
    return normalizeAddress(entry);
  });
}

async function askText(
  prompt: string,
  defaultValue?: string,
  allowEmpty = false,
): Promise<string> {
  const suffix =
    defaultValue === undefined ? "" : chalk.dim(` [${defaultValue}]`);
  const answer = (
    await rl.question(`${chalk.cyan("?")} ${prompt}${suffix}: `)
  ).trim();
  if (answer.length === 0) {
    if (defaultValue !== undefined) return defaultValue;
    if (allowEmpty) return "";
  }
  if (answer.length === 0) {
    console.log(chalk.yellow(`${emoji.get("warning")} Value is required.`));
    return askText(prompt, defaultValue, allowEmpty);
  }
  return answer;
}

async function askChoice<T extends string>(
  prompt: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  const answer = (await askText(prompt, defaultValue)).toLowerCase();
  const match = options.find((option) => option.toLowerCase() === answer);
  if (match !== undefined) {
    return match;
  }
  console.log(
    chalk.yellow(
      `${emoji.get("warning")} Choose one of: ${options.join(", ")}.`,
    ),
  );
  return askChoice(prompt, options, defaultValue);
}

async function askConfirm(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (
    await rl.question(
      `${chalk.magenta("?")} ${prompt} ${chalk.dim(`(${hint})`)}: `,
    )
  )
    .trim()
    .toLowerCase();

  if (answer.length === 0) return defaultYes;
  if (["y", "yes"].includes(answer)) return true;
  if (["n", "no"].includes(answer)) return false;
  console.log(chalk.yellow(`${emoji.get("warning")} Please answer yes or no.`));
  return askConfirm(prompt, defaultYes);
}

async function askAddress(
  prompt: string,
  defaultValue?: Address,
): Promise<Address> {
  const answer = await askText(prompt, defaultValue);
  try {
    return normalizeAddress(answer);
  } catch {
    console.log(
      chalk.yellow(`${emoji.get("warning")} ${answer} is not a valid address.`),
    );
    return askAddress(prompt, defaultValue);
  }
}

async function askDistinctAddress(
  prompt: string,
  forbidden: Address,
  defaultValue?: Address,
): Promise<Address> {
  const address = await askAddress(prompt, defaultValue);
  if (sameAddress(address, forbidden)) {
    console.log(
      chalk.yellow(
        `${emoji.get("warning")} ${prompt} must not equal ${forbidden}.`,
      ),
    );
    return askDistinctAddress(prompt, forbidden, defaultValue);
  }
  return address;
}

function renderDefaultGroup(title: string, lines: string[]) {
  console.log(chalk.dim(`${title}:`));
  for (const line of lines) {
    console.log(chalk.dim(`  - ${line}`));
  }
}

async function askUseDefaults(
  title: string,
  lines: string[],
  prompt: string,
  defaultYes = true,
): Promise<boolean> {
  renderDefaultGroup(title, lines);
  return askConfirm(prompt, defaultYes);
}

async function chooseConfiguredValues<T>(args: {
  available?: boolean;
  lines: string[];
  prompt: string;
  title: string;
  promptForCustom: () => Promise<T>;
  useDefaults: () => T;
}): Promise<T> {
  if (
    (args.available ?? true) &&
    (await askUseDefaults(args.title, args.lines, args.prompt))
  ) {
    return args.useDefaults();
  }

  return args.promptForCustom();
}

async function askAddressArray(
  prompt: string,
  defaultValue: Address[],
): Promise<Address[]> {
  const defaultText = defaultValue.join(", ");
  const answer = await askText(prompt, defaultText);
  try {
    return answer
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeAddress(entry));
  } catch {
    console.log(
      chalk.yellow(
        `${emoji.get("warning")} Enter comma-separated 0x addresses.`,
      ),
    );
    return askAddressArray(prompt, defaultValue);
  }
}

async function askBigint(
  prompt: string,
  defaultValue: bigint,
): Promise<bigint> {
  const answer = await askText(prompt, bigintText(defaultValue));
  try {
    return parseBigintLike(answer, prompt);
  } catch {
    console.log(
      chalk.yellow(
        `${emoji.get("warning")} ${answer} is not a valid bigint value.`,
      ),
    );
    return askBigint(prompt, defaultValue);
  }
}

function renderSection(title: string, description?: string) {
  const divider = chalk.blue("=".repeat(72));
  console.log(`\n${divider}`);
  console.log(
    chalk.bold.blue(`${emoji.get("triangular_flag_on_post")} ${title}`),
  );
  if (description !== undefined) {
    console.log(chalk.dim(description));
  }
  console.log(divider);
}

function classifyFailureHint(message: string): string | undefined {
  if (message.includes("exceeds the balance")) {
    return "Deployer balance is too low for this step. Fund the deployer with the network's native token and retry.";
  }
  if (message.includes("ECONNRESET")) {
    return "The RPC connection was reset mid-step. This is usually provider instability; retry the step or switch RPC providers.";
  }
  if (message.includes("Failed to make POST request")) {
    return "The RPC provider dropped or refused the request. Retry the step or use a different Sepolia endpoint.";
  }
  if (message.includes("unexpected status code")) {
    return "RPC provider returned an HTTP error. Retry the step or switch to a more reliable RPC endpoint.";
  }
  if (message.includes("HHE10402")) {
    return "Previous same-signer transactions are still settling. Wait for confirmations and rerun the step.";
  }
  if (message.includes("Configuration Variable")) {
    return "A required environment variable is missing. Check `.env` loading and the network-specific RPC/private-key values.";
  }
  if (message.includes("Artifact for contract")) {
    return "Hardhat could not resolve a deployable artifact. Check the Ignition module's contract name or artifact wiring.";
  }
  return undefined;
}

function toOperationStepStatus(status: StepStatus): OperationStatus {
  if (status === "completed") return "complete";
  if (status === "aborted") return "aborted";
  return "prepared";
}

function initialStackRecordStatus(
  manifest: DeploymentManifest,
): OperationStatus {
  if (manifest.steps.some((step) => step.status === "aborted")) {
    return "aborted";
  }
  if (
    manifest.steps.length > 0 &&
    manifest.steps.every((step) => step.status === "completed")
  ) {
    return manifest.environment.grvtEnv === "production"
      ? "awaiting_handoff"
      : "complete";
  }
  return "prepared";
}

function stepAddressesOrUndefined(
  manifest: DeploymentManifest,
  stepName: string,
): Record<string, string> | undefined {
  return manifest.steps.find((step) => step.name === stepName)?.addresses;
}

function buildInitialStackOperationRecord(
  manifest: DeploymentManifest,
): OperationRecord {
  const vaultCoreAddresses = stepAddressesOrUndefined(
    manifest,
    "Vault core deployment",
  );
  const strategyCoreAddresses = stepAddressesOrUndefined(
    manifest,
    "Strategy core deployment",
  );
  const timelockAddresses = stepAddressesOrUndefined(
    manifest,
    "Yield recipient timelock bootstrap",
  );
  const nativeGatewayAddresses = stepAddressesOrUndefined(
    manifest,
    "Native gateways deployment",
  );
  const longLivedAuthority =
    typeof manifest.resolvedParams.productionAuthorityPlan === "object" &&
    manifest.resolvedParams.productionAuthorityPlan !== null &&
    typeof (
      manifest.resolvedParams.productionAuthorityPlan as {
        finalVaultAdmin?: unknown;
      }
    ).finalVaultAdmin === "string"
      ? (
          manifest.resolvedParams.productionAuthorityPlan as {
            finalVaultAdmin: string;
          }
        ).finalVaultAdmin
      : String(
          (manifest.resolvedParams.vaultCore as { deployAdmin?: unknown })
            .deployAdmin ?? manifest.network.deployer,
        );

  return {
    actor: {
      longLivedAuthority,
      signer: manifest.network.deployer,
    },
    chainId: manifest.network.chainId,
    checklist:
      manifest.environment.grvtEnv === "production"
        ? [
            "Run ops:production-admin-handoff before treating this deployment as live.",
          ]
        : [
            "Review the saved record and run manual funding/allocation smoke checks.",
          ],
    createdAt: manifest.createdAt,
    environment: manifest.environment.grvtEnv,
    inputs: {
      aaveMode: manifest.environment.aaveMode,
      localMode: manifest.environment.localMode,
      networkAlias: manifest.network.alias,
      parameterDir: relativePath(manifest.environment.parameterDir),
      repeatStepConfirmations: manifest.environment.repeatStepConfirmations,
      resolvedParams: manifest.resolvedParams,
      runPostDeployVerification: manifest.environment.runPostDeployVerification,
      sourceParameterFiles: Object.fromEntries(
        Object.entries(manifest.sourceParameterFiles).map(([key, value]) => [
          key,
          relativePath(value),
        ]),
      ),
    },
    kind: "initial-stack",
    mode: "direct",
    network: manifest.network.name,
    outputs: {
      networkAlias: manifest.network.alias,
      nativeBridgeGatewayImplementation:
        nativeGatewayAddresses?.nativeBridgeGatewayImplementation,
      nativeBridgeGatewayProxy:
        nativeGatewayAddresses?.nativeBridgeGatewayProxy,
      nativeBridgeGatewayProxyAdmin:
        nativeGatewayAddresses?.nativeBridgeGatewayProxyAdmin,
      nativeVaultGateway: nativeGatewayAddresses?.nativeVaultGateway,
      strategyImplementation: strategyCoreAddresses?.strategyImplementation,
      strategyProxy: strategyCoreAddresses?.strategyProxy,
      strategyProxyAdmin: strategyCoreAddresses?.strategyProxyAdmin,
      vaultImplementation: vaultCoreAddresses?.vaultImplementation,
      vaultProxy: vaultCoreAddresses?.vaultProxy,
      vaultProxyAdmin: vaultCoreAddresses?.vaultProxyAdmin,
      yieldRecipientTimelockController:
        timelockAddresses?.yieldRecipientTimelockController,
    },
    recordId: manifest.runId,
    schemaVersion: OPERATION_RECORD_SCHEMA_VERSION,
    status: initialStackRecordStatus(manifest),
    steps: manifest.steps.map(
      (step): OperationStep => ({
        addresses: step.addresses,
        artifacts:
          step.logFiles === undefined
            ? undefined
            : [
                { path: relativePath(step.logFiles.stdout) },
                { path: relativePath(step.logFiles.stderr) },
              ],
        command: step.command,
        completedAt: step.completedAt,
        deploymentId: extractDeploymentId(step.command),
        duration: step.duration,
        label: step.name,
        logFiles:
          step.logFiles === undefined
            ? undefined
            : {
                stderr: relativePath(step.logFiles.stderr),
                stdout: relativePath(step.logFiles.stdout),
              },
        nextAction: step.nextAction,
        notes: [
          ...(step.notes ?? []),
          ...(step.nextAction === undefined ? [] : [step.nextAction]),
          ...(step.command === undefined ? [] : [step.command]),
        ],
        startedAt: step.startedAt,
        status: toOperationStepStatus(step.status),
      }),
    ),
  };
}

function persistManifest(runDir: string, manifest: DeploymentManifest) {
  writeOperationRecord(runDir, buildInitialStackOperationRecord(manifest));
}

async function readTokenMetadata(
  publicClient: PublicClient,
  token: Address,
): Promise<ReadonlyContractMetadata> {
  const metadata: ReadonlyContractMetadata = {};
  for (const field of ["name", "symbol", "decimals"] as const) {
    try {
      const value = await publicClient.readContract({
        address: token,
        abi: ERC20_METADATA_ABI,
        functionName: field,
      });
      if (field === "decimals") {
        metadata.decimals = Number(value);
      } else {
        metadata[field] = String(value);
      }
    } catch {
      // Non-standard ERC20 metadata is acceptable here; fall back to prompts.
    }
  }
  return metadata;
}

async function requireDeployedContract(
  publicClient: {
    getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  },
  address: Address,
  label: string,
) {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} is not a deployed contract: ${address}`);
  }
}

function requireUsdtMetadata(
  metadata: ReadonlyContractMetadata,
  address: Address,
): void {
  if (metadata.symbol === undefined) {
    throw new Error(`USDT token metadata is missing symbol(): ${address}`);
  }
  if (metadata.decimals === undefined) {
    throw new Error(`USDT token metadata is missing decimals(): ${address}`);
  }
  if (metadata.symbol.toUpperCase() !== "USDT") {
    throw new Error(
      `configured token symbol must be USDT, received ${metadata.symbol}: ${address}`,
    );
  }
  if (metadata.decimals !== 6) {
    throw new Error(
      `configured USDT token must use 6 decimals, received ${String(metadata.decimals)}: ${address}`,
    );
  }
}

async function validateUsdtToken(args: {
  address: Address;
  label: string;
  publicClient: PublicClient;
}): Promise<ReadonlyContractMetadata> {
  await requireDeployedContract(args.publicClient, args.address, args.label);
  const metadata = await readTokenMetadata(args.publicClient, args.address);
  requireUsdtMetadata(metadata, args.address);
  renderTokenMetadataSummary(metadata);
  return metadata;
}

async function resolveUsdtTokenAddress(args: {
  configuredAddress?: Address;
  prompt: string;
  publicClient: PublicClient;
}): Promise<{ metadata: ReadonlyContractMetadata; token: Address }> {
  if (args.configuredAddress !== undefined) {
    const metadata = await validateUsdtToken({
      address: args.configuredAddress,
      label: "Configured USDT token",
      publicClient: args.publicClient,
    });
    return {
      metadata,
      token: args.configuredAddress,
    };
  }

  const token = await askAddress(args.prompt);

  try {
    const metadata = await validateUsdtToken({
      address: token,
      label: args.prompt,
      publicClient: args.publicClient,
    });
    return { metadata, token };
  } catch (error) {
    console.log(
      chalk.yellow(
        `${emoji.get("warning")} ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return resolveUsdtTokenAddress(args);
  }
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

  if (raw === undefined) throw new Error("missing proxy admin slot value");

  const hex = raw.slice(2);
  const admin = `0x${hex.slice(24)}` as Address;
  return getAddress(admin);
}

async function validateAaveStrategyPrerequisites(args: {
  aTokenAddress: Address;
  aaveMode: AaveMode;
  aavePoolAddress: Address;
  publicClient: PublicClient;
  underlyingToken: Address;
}) {
  await requireDeployedContract(
    args.publicClient,
    args.underlyingToken,
    "underlying token",
  );
  await requireDeployedContract(
    args.publicClient,
    args.aTokenAddress,
    "aToken",
  );
  await requireDeployedContract(
    args.publicClient,
    args.aavePoolAddress,
    "Aave pool",
  );

  const linkedUnderlying = normalizeAddress(
    String(
      await args.publicClient.readContract({
        abi: MOCK_AAVE_ATOKEN_ABI,
        address: args.aTokenAddress,
        functionName: "UNDERLYING_ASSET_ADDRESS",
      }),
    ),
  );
  const linkedPool = normalizeAddress(
    String(
      await args.publicClient.readContract({
        abi: MOCK_AAVE_ATOKEN_ABI,
        address: args.aTokenAddress,
        functionName: "POOL",
      }),
    ),
  );

  if (!sameAddress(linkedUnderlying, args.underlyingToken)) {
    throw new Error("aToken underlying mismatch against the configured token");
  }
  if (!sameAddress(linkedPool, args.aavePoolAddress)) {
    throw new Error("aToken pool mismatch against the configured Aave pool");
  }

  if (args.aaveMode === "mock-aave") {
    const configuredAToken = normalizeAddress(
      String(
        await args.publicClient.readContract({
          abi: MOCK_AAVE_POOL_ABI,
          address: args.aavePoolAddress,
          functionName: "aToken",
        }),
      ),
    );
    if (!sameAddress(configuredAToken, args.aTokenAddress)) {
      throw new Error("mock pool aToken mismatch after deployment");
    }
  }
}

async function runCommand(
  command: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", resolveCode);
  });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  return { code, stderr, stdout };
}

function readIgnitionDeployedAddresses(
  deploymentId: string,
): Record<string, string> {
  const outputPath = join(
    repoRoot,
    "ignition",
    "deployments",
    deploymentId,
    "deployed_addresses.json",
  );
  return JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, string>;
}

function deploymentCommandText(
  modulePath: string,
  paramsFileName: string,
  deploymentId: string,
  networkName: string,
): string {
  return [
    "npx hardhat ignition deploy",
    modulePath,
    `--network ${networkName}`,
    `--parameters <temporary:${paramsFileName}>`,
    `--deployment-id ${deploymentId}`,
    "--reset",
  ].join(" ");
}

function verificationCommandText(runDir: string): string {
  return [
    "npx tsx",
    "./scripts/verify/verify-initial-stack.ts",
    `--run-dir ${relativePath(runDir)}`,
  ].join(" ");
}

async function confirmStep(
  stepName: string,
  nextAction: string,
  repeatStepConfirmations: boolean,
) {
  console.log(chalk.bold(`${emoji.get("eyes")} Next up: ${stepName}`));
  console.log(chalk.dim(nextAction));
  if (!repeatStepConfirmations) {
    console.log(
      chalk.dim(
        "Per-step confirmations are disabled for this run; auto-proceeding.",
      ),
    );
    return;
  }
  const confirmed = await askConfirm(`Proceed with ${stepName}?`, true);
  if (!confirmed) {
    throw new UserAbortError(`aborted before ${stepName}`);
  }
}

async function resolveGrvtEnvironment(
  localMode: boolean,
): Promise<GrvtEnvironment> {
  const envValue = process.env.GRVT_ENV;
  if (envValue !== undefined && envValue.trim().length > 0) {
    return parseGrvtEnvironment(envValue.trim(), "GRVT_ENV");
  }

  if (localMode) {
    return "staging";
  }

  renderSection(
    "Environment Selection",
    "Choose which GRVT parameter environment to use for defaults, artifacts, and deployment IDs.",
  );
  return askChoice("GRVT environment", GRVT_ENVIRONMENTS, "staging");
}

async function runPreflight(args: {
  aaveMode: AaveMode;
  chainId: number;
  deployer: Address;
  displayNetwork: string;
  grvtEnvironment: GrvtEnvironment;
  localMode: boolean;
  parameterDir: string;
  publicClient: PublicClient;
}) {
  const balance = await args.publicClient.getBalance({
    address: args.deployer,
  });
  const issues: string[] = [];

  if (args.localMode && args.grvtEnvironment === "production") {
    issues.push(
      "Local mode only supports mock-Aave environments. Use `staging` or `testnet`, or run production against a live network.",
    );
  }
  if (
    !args.localMode &&
    args.grvtEnvironment === "production" &&
    args.chainId !== 1
  ) {
    issues.push(
      "Production environment expects Ethereum mainnet (chainId 1) because it uses live Aave mainnet addresses.",
    );
  }
  if (
    !args.localMode &&
    args.grvtEnvironment !== "production" &&
    args.chainId !== 11155111
  ) {
    issues.push(
      "Non-production environments are expected to run on Sepolia (chainId 11155111) in this repository.",
    );
  }
  if (!args.localMode && balance === 0n) {
    issues.push(
      "Deployer balance is 0 native tokens. Fund the deployer before starting the deployment.",
    );
  }
  if (!existsSync(args.parameterDir)) {
    issues.push(
      `Parameter directory does not exist: ${relativePath(args.parameterDir)}`,
    );
  }
  if (args.localMode && !existsSync(smokePrerequisitesPath)) {
    issues.push(
      `Smoke prerequisites file does not exist: ${relativePath(smokePrerequisitesPath)}`,
    );
  }

  renderSection("Preflight", "Operator context before parameter collection.");
  const lines = [
    `${emoji.get("bookmark_tabs")} GRVT environment: ${args.grvtEnvironment}`,
    `${emoji.get("shield")} Aave mode: ${aaveModeLabel(args.aaveMode)}`,
    `${emoji.get("globe_with_meridians")} target network: ${args.displayNetwork}`,
    `${emoji.get("satellite")} chainId: ${args.chainId}`,
    `${emoji.get("bust_in_silhouette")} deployer: ${args.deployer}`,
    `${emoji.get("money_with_wings")} deployer balance: ${formatEther(balance)} native`,
    `${emoji.get("file_folder")} parameter dir: ${relativePath(args.parameterDir)}`,
    args.localMode
      ? `${emoji.get("card_index")} smoke prerequisites: ${relativePath(smokePrerequisitesPath)}`
      : undefined,
  ].filter((line): line is string => line !== undefined);

  for (const line of lines) {
    console.log(chalk.white(`- ${line}`));
  }
  console.log(
    chalk.dim(
      args.aaveMode === "mock-aave"
        ? "Non-production environments deploy mock Aave contracts because GRVT supplies its own underlying token instead of assuming a public Aave reserve supports it."
        : "Production validates the configured live Aave pool and aToken instead of deploying mocks.",
    ),
  );

  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }
}

async function resolveLocalParams(
  deployerAddress: Address,
  grvtEnvironment: GrvtEnvironment,
  parameterDir: string,
  publicClient: PublicClient,
): Promise<ResolvedParams> {
  const sources = loadParameterSources(parameterDir);
  const localPrereqs = readLocalSmokePrerequisites(smokePrerequisitesPath);

  if (!sameAddress(localPrereqs.deployAdmin, deployerAddress)) {
    throw new Error(
      [
        `local prerequisite values were produced for deployer ${localPrereqs.deployAdmin}`,
        `but current localhost deployer is ${deployerAddress}`,
        `refresh ${relativePath(smokePrerequisitesPath)} for this node`,
      ].join("; "),
    );
  }

  const underlyingMetadata = await readTokenMetadata(
    publicClient,
    localPrereqs.underlyingToken,
  );
  const aTokenMetadata = await readTokenMetadata(
    publicClient,
    localPrereqs.aToken,
  );

  renderSection(
    "Local Config Intake",
    `Loaded local prerequisite values from ${relativePath(smokePrerequisitesPath)} and reused ${grvtEnvironment} parameter defaults for the remaining fields. No interactive prompts will be shown in local mode.`,
  );

  const deployAdmin = localPrereqs.deployAdmin;
  const operatorDefaults = resolveOperatorDefaults(sources, deployAdmin);
  const timelockDefaults = resolveTimelockDefaults(
    sources.timelockSource,
    deployAdmin,
  );
  const supportFlags = resolveSupportFlags(sources);

  return {
    aTokenName:
      aTokenMetadata.name ??
      defaultATokenName(underlyingMetadata, grvtEnvironment),
    aTokenSymbol:
      aTokenMetadata.symbol ?? defaultATokenSymbol(underlyingMetadata),
    nativeGateways: {
      bridgeHub: localPrereqs.bridgeHub,
      grvtBridgeProxyFeeToken: localPrereqs.grvtBridgeProxyFeeToken,
      proxyAdminOwner: operatorDefaults.nativeProxyAdminOwner,
      wrappedNativeToken: localPrereqs.wrappedNativeToken,
    },
    rolesBootstrap: {
      allocator: localPrereqs.allocator,
      pauser: localPrereqs.pauser,
      rebalancer: localPrereqs.rebalancer,
    },
    strategyCore: {
      aToken: localPrereqs.aToken,
      aavePool: localPrereqs.aavePool,
      proxyAdminOwner: operatorDefaults.strategyProxyAdminOwner,
      strategyName: localPrereqs.strategyName,
      underlyingToken: localPrereqs.underlyingToken,
    },
    vaultCore: {
      bridgeHub: localPrereqs.bridgeHub,
      deployAdmin,
      grvtBridgeProxyFeeToken: localPrereqs.grvtBridgeProxyFeeToken,
      l2ChainId: localPrereqs.l2ChainId,
      l2ExchangeRecipient: localPrereqs.l2ExchangeRecipient,
      wrappedNativeToken: localPrereqs.wrappedNativeToken,
      yieldRecipient: localPrereqs.yieldRecipient,
    },
    vaultTokenConfig: {
      supported: supportFlags.supported,
      vaultToken: localPrereqs.underlyingToken,
    },
    vaultTokenStrategy: {
      strategyCap: localPrereqs.strategyCap,
      vaultToken: localPrereqs.underlyingToken,
      vaultTokenStrategyWhitelisted: supportFlags.whitelisted,
      vaultTokenSupported: supportFlags.supported,
    },
    yieldRecipientBootstrap: {
      admin: timelockDefaults.admin,
      executors: timelockDefaults.executors,
      minDelay: timelockDefaults.minDelay,
      proposers: timelockDefaults.proposers,
    },
  };
}

async function collectVaultCoreParams(args: {
  deployerAddress: Address;
  grvtEnvironment: GrvtEnvironment;
  sources: ParameterSources;
}): Promise<VaultCoreParams> {
  const configuredFinalVaultAdmin = defaultAddressValue(
    args.sources.vaultCoreSource.deployAdmin,
  );
  const deployAdmin =
    args.grvtEnvironment === "production"
      ? await askAddress(
          "Bootstrap vault admin / vault ProxyAdmin owner",
          args.deployerAddress,
        )
      : await askAddress(
          "Vault admin / vault ProxyAdmin owner",
          defaultAddressValue(
            args.sources.vaultCoreSource.deployAdmin,
            args.deployerAddress,
          ),
        );
  const finalVaultAdmin =
    args.grvtEnvironment === "production"
      ? await askDistinctAddress(
          "Final vault admin after handoff",
          deployAdmin,
          configuredFinalVaultAdmin,
        )
      : undefined;
  const coreDefaults = {
    bridgeHub: defaultAddressValue(args.sources.vaultCoreSource.bridgeHub),
    grvtBridgeProxyFeeToken: defaultAddressValue(
      args.sources.vaultCoreSource.grvtBridgeProxyFeeToken,
    ),
    l2ChainId: parseBigintLike(
      args.sources.vaultCoreSource.l2ChainId ?? "327n",
      "l2ChainId",
    ),
    l2ExchangeRecipient: defaultAddressValue(
      args.sources.vaultCoreSource.l2ExchangeRecipient,
      deployAdmin,
    ),
    wrappedNativeToken: defaultAddressValue(
      args.sources.vaultCoreSource.wrappedNativeToken,
    ),
    yieldRecipient: defaultAddressValue(
      args.sources.vaultCoreSource.yieldRecipient,
    ),
  };

  const defaultsAvailable =
    coreDefaults.bridgeHub !== undefined &&
    coreDefaults.grvtBridgeProxyFeeToken !== undefined &&
    coreDefaults.l2ExchangeRecipient !== undefined &&
    coreDefaults.wrappedNativeToken !== undefined &&
    coreDefaults.yieldRecipient !== undefined &&
    !sameAddress(coreDefaults.yieldRecipient, deployAdmin);

  const selectedCoreValues = await chooseConfiguredValues({
    available: defaultsAvailable,
    lines: [
      `bridgeHub: ${coreDefaults.bridgeHub}`,
      `fee token: ${coreDefaults.grvtBridgeProxyFeeToken}`,
      `l2ChainId: ${bigintText(coreDefaults.l2ChainId)}`,
      `l2ExchangeRecipient: ${coreDefaults.l2ExchangeRecipient}`,
      `wrappedNativeToken: ${coreDefaults.wrappedNativeToken}`,
      `yieldRecipient: ${coreDefaults.yieldRecipient}`,
    ],
    prompt: "Use these vault/core defaults?",
    title: "Default vault/core values",
    promptForCustom: async () => ({
      bridgeHub: await askAddress("BridgeHub address", coreDefaults.bridgeHub),
      grvtBridgeProxyFeeToken: await askAddress(
        "GRVT bridge-proxy fee token",
        coreDefaults.grvtBridgeProxyFeeToken,
      ),
      l2ChainId: await askBigint("L2 chain id", coreDefaults.l2ChainId),
      l2ExchangeRecipient: await askAddress(
        "L2 exchange recipient",
        coreDefaults.l2ExchangeRecipient,
      ),
      wrappedNativeToken: await askAddress(
        "Wrapped native token",
        coreDefaults.wrappedNativeToken,
      ),
      yieldRecipient: await askDistinctAddress(
        "Initial yield recipient",
        deployAdmin,
        coreDefaults.yieldRecipient,
      ),
    }),
    useDefaults: () => ({
      bridgeHub: coreDefaults.bridgeHub!,
      grvtBridgeProxyFeeToken: coreDefaults.grvtBridgeProxyFeeToken!,
      l2ChainId: coreDefaults.l2ChainId,
      l2ExchangeRecipient: coreDefaults.l2ExchangeRecipient!,
      wrappedNativeToken: coreDefaults.wrappedNativeToken!,
      yieldRecipient: coreDefaults.yieldRecipient!,
    }),
  });

  return {
    deployAdmin,
    finalVaultAdmin,
    ...selectedCoreValues,
  };
}

async function collectStrategyPrerequisites(args: {
  aaveMode: AaveMode;
  grvtEnvironment: GrvtEnvironment;
  publicClient: PublicClient;
  strategyCoreSource: JsonRecord;
}): Promise<StrategyPrerequisiteSelections> {
  const configuredUsdtAddress = defaultAddressValue(
    args.strategyCoreSource.underlyingToken,
  );
  const selectedUnderlyingToken = await resolveUsdtTokenAddress({
    configuredAddress: configuredUsdtAddress,
    prompt:
      args.aaveMode === "mock-aave"
        ? "USDT token for mock Aave strategy"
        : "USDT token for live Aave strategy",
    publicClient: args.publicClient,
  });
  const underlyingToken = selectedUnderlyingToken.token;
  const metadata = selectedUnderlyingToken.metadata;

  if (args.aaveMode === "mock-aave") {
    const selections = {
      aTokenName: defaultATokenName(metadata, args.grvtEnvironment),
      aTokenSymbol: defaultATokenSymbol(metadata),
      strategyName: defaultStrategyName(
        args.strategyCoreSource,
        metadata,
        args.grvtEnvironment,
        args.aaveMode,
      ),
      underlyingToken,
    };

    renderDefaultGroup("Mock Aave deployment defaults", [
      `underlying token: ${underlyingToken}`,
      `aToken name: ${selections.aTokenName}`,
      `aToken symbol: ${selections.aTokenSymbol}`,
      `strategyName: ${selections.strategyName}`,
    ]);

    return selections;
  }

  const liveDefaults = {
    aToken: defaultAddressValue(args.strategyCoreSource.aToken),
    aavePool: defaultAddressValue(args.strategyCoreSource.aavePool),
    strategyName: defaultStrategyName(
      args.strategyCoreSource,
      metadata,
      args.grvtEnvironment,
      args.aaveMode,
    ),
  };

  const liveSelections = await chooseConfiguredValues({
    available:
      liveDefaults.aToken !== undefined && liveDefaults.aavePool !== undefined,
    lines: [
      `aavePool: ${liveDefaults.aavePool}`,
      `aToken: ${liveDefaults.aToken}`,
      `strategyName: ${liveDefaults.strategyName}`,
    ],
    prompt: "Use these live Aave values?",
    title: "Configured live Aave values",
    promptForCustom: async () => ({
      aToken: await askAddress("Aave aToken", liveDefaults.aToken),
      aavePool: await askAddress("Aave pool", liveDefaults.aavePool),
      strategyName: await askText("Strategy name", liveDefaults.strategyName),
    }),
    useDefaults: () => ({
      aToken: liveDefaults.aToken,
      aavePool: liveDefaults.aavePool,
      strategyName: liveDefaults.strategyName,
    }),
  });

  return {
    ...liveSelections,
    aTokenName: "",
    aTokenSymbol: "",
    underlyingToken,
  };
}

async function collectProxyAdminOwners(args: {
  defaultAuthority: Address;
  sources: ParameterSources;
}): Promise<ProxyAdminOwners> {
  const operatorDefaults = resolveOperatorDefaults(
    args.sources,
    args.defaultAuthority,
  );

  return chooseConfiguredValues({
    lines: [
      `strategy ProxyAdmin owner: ${operatorDefaults.strategyProxyAdminOwner}`,
      `native gateway ProxyAdmin owner: ${operatorDefaults.nativeProxyAdminOwner}`,
    ],
    prompt: "Use these proxy-admin defaults?",
    title: "Default proxy-admin owners",
    promptForCustom: async () => ({
      nativeProxyAdminOwner: await askAddress(
        "NativeBridgeGateway ProxyAdmin owner",
        operatorDefaults.nativeProxyAdminOwner,
      ),
      strategyProxyAdminOwner: await askAddress(
        "Strategy ProxyAdmin owner",
        operatorDefaults.strategyProxyAdminOwner,
      ),
    }),
    useDefaults: () => ({
      nativeProxyAdminOwner: operatorDefaults.nativeProxyAdminOwner,
      strategyProxyAdminOwner: operatorDefaults.strategyProxyAdminOwner,
    }),
  });
}

async function collectRolesAndTimelockSelections(args: {
  defaultAuthority: Address;
  sources: ParameterSources;
}): Promise<RoleAndTimelockSelections> {
  const operatorDefaults = resolveOperatorDefaults(
    args.sources,
    args.defaultAuthority,
  );
  const timelockDefaults = resolveTimelockDefaults(
    args.sources.timelockSource,
    args.defaultAuthority,
  );

  return chooseConfiguredValues({
    lines: [
      `allocator: ${operatorDefaults.allocator}`,
      `rebalancer: ${operatorDefaults.rebalancer}`,
      `pauser: ${operatorDefaults.pauser}`,
      `timelock minDelay: ${bigintText(timelockDefaults.minDelay)}`,
      `timelock admin: ${timelockDefaults.admin}`,
      `timelock proposers: ${timelockDefaults.proposers.join(", ")}`,
      `timelock executors: ${timelockDefaults.executors.join(", ")}`,
    ],
    prompt: "Use these operator-role and timelock defaults?",
    title: "Default operator roles and timelock settings",
    promptForCustom: async () => ({
      admin: await askAddress("Yield timelock admin", timelockDefaults.admin),
      allocator: await askAddress(
        "Allocator role holder",
        operatorDefaults.allocator,
      ),
      executors: await askAddressArray(
        "Yield timelock executors (comma-separated)",
        timelockDefaults.executors,
      ),
      minDelay: await askBigint(
        "Yield timelock minDelay",
        timelockDefaults.minDelay,
      ),
      pauser: await askAddress("Pauser role holder", operatorDefaults.pauser),
      proposers: await askAddressArray(
        "Yield timelock proposers (comma-separated)",
        timelockDefaults.proposers,
      ),
      rebalancer: await askAddress(
        "Rebalancer role holder",
        operatorDefaults.rebalancer,
      ),
    }),
    useDefaults: () => ({
      admin: timelockDefaults.admin,
      allocator: operatorDefaults.allocator,
      executors: timelockDefaults.executors,
      minDelay: timelockDefaults.minDelay,
      pauser: operatorDefaults.pauser,
      proposers: timelockDefaults.proposers,
      rebalancer: operatorDefaults.rebalancer,
    }),
  });
}

async function promptResolvedParams(args: {
  aaveMode: AaveMode;
  deployerAddress: Address;
  grvtEnvironment: GrvtEnvironment;
  localMode: boolean;
  parameterDir: string;
  publicClient: PublicClient;
}): Promise<ResolvedParams> {
  if (args.localMode) {
    return resolveLocalParams(
      args.deployerAddress,
      args.grvtEnvironment,
      args.parameterDir,
      args.publicClient,
    );
  }

  const sources = loadParameterSources(args.parameterDir);

  renderSection(
    `${environmentLabel(args.grvtEnvironment)} Config Intake`,
    "Missing or placeholder values will be asked interactively. Valid defaults can be accepted in groups.",
  );

  const vaultCore = await collectVaultCoreParams({
    deployerAddress: args.deployerAddress,
    grvtEnvironment: args.grvtEnvironment,
    sources,
  });
  const longLivedAuthority =
    args.grvtEnvironment === "production" &&
    vaultCore.finalVaultAdmin !== undefined
      ? vaultCore.finalVaultAdmin
      : vaultCore.deployAdmin;
  const strategyPrereqs = await collectStrategyPrerequisites({
    aaveMode: args.aaveMode,
    grvtEnvironment: args.grvtEnvironment,
    publicClient: args.publicClient,
    strategyCoreSource: sources.strategyCoreSource,
  });
  const proxyAdminOwners = await collectProxyAdminOwners({
    defaultAuthority: longLivedAuthority,
    sources,
  });
  const roleAndTimelockSelections = await collectRolesAndTimelockSelections({
    defaultAuthority: longLivedAuthority,
    sources,
  });
  const strategyCap = await askBigint(
    "Initial strategy cap (0n = Unlimited)",
    parseBigintLike(
      sources.vaultTokenStrategySource.strategyCap ?? "0n",
      "strategyCap",
    ),
  );
  const supportFlags = resolveSupportFlags(sources);

  return {
    aTokenName: strategyPrereqs.aTokenName,
    aTokenSymbol: strategyPrereqs.aTokenSymbol,
    productionAuthorityPlan:
      args.grvtEnvironment === "production" &&
      vaultCore.finalVaultAdmin !== undefined
        ? {
            bootstrapVaultAdmin: vaultCore.deployAdmin,
            finalVaultAdmin: vaultCore.finalVaultAdmin,
          }
        : undefined,
    nativeGateways: {
      bridgeHub: vaultCore.bridgeHub,
      grvtBridgeProxyFeeToken: vaultCore.grvtBridgeProxyFeeToken,
      proxyAdminOwner: proxyAdminOwners.nativeProxyAdminOwner,
      wrappedNativeToken: vaultCore.wrappedNativeToken,
    },
    rolesBootstrap: {
      allocator: roleAndTimelockSelections.allocator,
      pauser: roleAndTimelockSelections.pauser,
      rebalancer: roleAndTimelockSelections.rebalancer,
    },
    strategyCore: {
      aToken: strategyPrereqs.aToken,
      aavePool: strategyPrereqs.aavePool,
      proxyAdminOwner: proxyAdminOwners.strategyProxyAdminOwner,
      strategyName: strategyPrereqs.strategyName,
      underlyingToken: strategyPrereqs.underlyingToken,
    },
    vaultCore,
    vaultTokenConfig: {
      supported: supportFlags.supported,
    },
    vaultTokenStrategy: {
      strategyCap,
      vaultTokenStrategyWhitelisted: supportFlags.whitelisted,
      vaultTokenSupported: supportFlags.supported,
    },
    yieldRecipientBootstrap: {
      admin: roleAndTimelockSelections.admin,
      executors: roleAndTimelockSelections.executors,
      minDelay: roleAndTimelockSelections.minDelay,
      proposers: roleAndTimelockSelections.proposers,
    },
  };
}

function renderResolvedConfig(args: {
  aaveMode: AaveMode;
  grvtEnvironment: GrvtEnvironment;
  parameterDir: string;
  params: ResolvedParams;
}) {
  renderSection(
    "Resolved Deployment Plan",
    "These values will be staged in temporary per-step parameter files. Source parameter files remain untouched.",
  );
  const lines = [
    `${emoji.get("bookmark_tabs")} GRVT environment: ${args.grvtEnvironment}`,
    `${emoji.get("shield")} Aave mode: ${aaveModeLabel(args.aaveMode)}`,
    `${emoji.get("file_folder")} parameter dir: ${relativePath(args.parameterDir)}`,
    `${
      args.params.productionAuthorityPlan === undefined
        ? emoji.get("bust_in_silhouette")
        : emoji.get("construction_worker")
    } deployAdmin: ${args.params.vaultCore.deployAdmin}`,
    `${emoji.get("link")} bridgeHub: ${args.params.vaultCore.bridgeHub}`,
    `${emoji.get("credit_card")} fee token: ${args.params.vaultCore.grvtBridgeProxyFeeToken}`,
    `${emoji.get("droplet")} wrappedNativeToken: ${args.params.vaultCore.wrappedNativeToken}`,
    `${emoji.get("satellite")} l2ChainId: ${bigintText(args.params.vaultCore.l2ChainId)}`,
    `${emoji.get("incoming_envelope")} l2ExchangeRecipient: ${args.params.vaultCore.l2ExchangeRecipient}`,
    `${emoji.get("moneybag")} yieldRecipient: ${args.params.vaultCore.yieldRecipient}`,
    `${emoji.get("bookmark_tabs")} strategyName: ${args.params.strategyCore.strategyName}`,
    `${emoji.get("moneybag")} strategyCap: ${strategyCapText(args.params.vaultTokenStrategy.strategyCap)}`,
    `${emoji.get("key")} allocator/rebalancer/pauser: ${args.params.rolesBootstrap.allocator} / ${args.params.rolesBootstrap.rebalancer} / ${args.params.rolesBootstrap.pauser}`,
    `${emoji.get("hourglass")} timelock delay: ${bigintText(args.params.yieldRecipientBootstrap.minDelay)}`,
  ];

  if (args.params.productionAuthorityPlan !== undefined) {
    lines.push(
      `${emoji.get("shield")} finalVaultAdmin: ${args.params.productionAuthorityPlan.finalVaultAdmin}`,
    );
  }

  if (args.aaveMode === "mock-aave") {
    lines.push(
      `${emoji.get("package")} underlyingToken: ${args.params.strategyCore.underlyingToken}`,
    );
    lines.push(
      `${emoji.get("sparkles")} mock aToken: ${args.params.aTokenName} (${args.params.aTokenSymbol})`,
    );
    lines.push(`${emoji.get("bank")} mock Aave pool: deployed in Step 1`);
  } else {
    lines.push(
      `${emoji.get("package")} underlyingToken: ${args.params.strategyCore.underlyingToken}`,
    );
    lines.push(
      `${emoji.get("bank")} aavePool: ${args.params.strategyCore.aavePool}`,
    );
    lines.push(
      `${emoji.get("coin")} aToken: ${args.params.strategyCore.aToken}`,
    );
  }

  for (const line of lines) {
    console.log(chalk.white(`- ${line}`));
  }
}

function createInitialManifest(
  aaveMode: AaveMode,
  grvtEnvironment: GrvtEnvironment,
  localMode: boolean,
  parameterDir: string,
  repeatStepConfirmations: boolean,
  runPostDeployVerification: boolean,
  runId: string,
  runDir: string,
  networkAlias: string,
  networkName: string,
  chainId: number,
  deployer: Address,
  params: ResolvedParams,
): DeploymentManifest {
  return {
    artifactsDir: runDir,
    createdAt: nowIso(),
    environment: {
      aaveMode,
      grvtEnv: grvtEnvironment,
      localMode,
      parameterDir,
      repeatStepConfirmations,
      runPostDeployVerification,
    },
    network: {
      alias: networkAlias,
      chainId,
      deployer,
      name: networkName,
    },
    resolvedParams: {
      aTokenName: params.aTokenName,
      aTokenSymbol: params.aTokenSymbol,
      productionAuthorityPlan:
        params.productionAuthorityPlan === undefined
          ? undefined
          : { ...params.productionAuthorityPlan },
      nativeGateways: {
        ...params.nativeGateways,
      },
      rolesBootstrap: {
        ...params.rolesBootstrap,
      },
      strategyCore: {
        ...params.strategyCore,
      },
      vaultCore: {
        ...params.vaultCore,
        l2ChainId: bigintText(params.vaultCore.l2ChainId),
      },
      vaultTokenConfig: {
        ...params.vaultTokenConfig,
      },
      vaultTokenStrategy: {
        ...params.vaultTokenStrategy,
        strategyCap: bigintText(params.vaultTokenStrategy.strategyCap),
      },
      yieldRecipientBootstrap: {
        ...params.yieldRecipientBootstrap,
        minDelay: bigintText(params.yieldRecipientBootstrap.minDelay),
      },
    },
    runId,
    sourceParameterFiles: {
      nativeGateways: sourcePath(parameterDir, "core.json5"),
      rolesBootstrap: sourcePath(parameterDir, "roles-bootstrap.json5"),
      strategyCore: sourcePath(parameterDir, "strategy-core.json5"),
      vaultCore: sourcePath(parameterDir, "core.json5"),
      vaultTokenConfig: sourcePath(parameterDir, "vault-token-config.json5"),
      vaultTokenStrategy: sourcePath(
        parameterDir,
        "vault-token-strategy.json5",
      ),
      yieldRecipientBootstrap: sourcePath(
        parameterDir,
        "yield-recipient-bootstrap.json5",
      ),
    },
    steps: [],
  };
}

function extractDeploymentId(command: string | undefined): string | undefined {
  if (command === undefined) {
    return undefined;
  }

  const match = command.match(/(?:^|\s)--deployment-id\s+([^\s]+)/);
  return match?.[1];
}

function pushStep(
  manifest: DeploymentManifest,
  step: StepRecord,
  runDir: string,
) {
  manifest.steps.push(step);
}

function updateStep(
  manifest: DeploymentManifest,
  step: StepRecord,
  runDir: string,
) {
  const index = manifest.steps.findIndex(
    (candidate) =>
      candidate.name === step.name && candidate.startedAt === step.startedAt,
  );
  manifest.steps[index] = step;
}

function mergeManifestResolvedSections(
  manifest: DeploymentManifest,
  runDir: string,
  sectionPatches: Record<string, JsonRecord>,
) {
  manifest.resolvedParams = {
    ...manifest.resolvedParams,
    ...Object.fromEntries(
      Object.entries(sectionPatches).map(([section, patch]) => [
        section,
        {
          ...(manifest.resolvedParams[section] as JsonRecord | undefined),
          ...patch,
        },
      ]),
    ),
  };
}

function recordResolvedPrerequisites(
  manifest: DeploymentManifest,
  runDir: string,
  resolvedParams: ResolvedParams,
  underlyingToken: Address,
  aavePool: Address,
  aToken: Address,
) {
  resolvedParams.strategyCore.underlyingToken = underlyingToken;
  resolvedParams.strategyCore.aToken = aToken;
  resolvedParams.strategyCore.aavePool = aavePool;
  resolvedParams.vaultTokenConfig.vaultToken = underlyingToken;
  resolvedParams.vaultTokenStrategy.vaultToken = underlyingToken;
  mergeManifestResolvedSections(manifest, runDir, {
    strategyCore: {
      underlyingToken,
      aToken,
      aavePool,
    },
    vaultTokenConfig: {
      vaultToken: underlyingToken,
    },
    vaultTokenStrategy: {
      vaultToken: underlyingToken,
    },
  });
}

function recordVaultProxy(
  manifest: DeploymentManifest,
  runDir: string,
  resolvedParams: ResolvedParams,
  vaultProxy: Address,
) {
  resolvedParams.strategyCore.vaultProxy = vaultProxy;
  resolvedParams.vaultTokenConfig.vaultProxy = vaultProxy;
  resolvedParams.vaultTokenStrategy.vaultProxy = vaultProxy;
  resolvedParams.rolesBootstrap.vaultProxy = vaultProxy;
  resolvedParams.yieldRecipientBootstrap.vaultProxy = vaultProxy;
  resolvedParams.nativeGateways.vaultProxy = vaultProxy;
  mergeManifestResolvedSections(manifest, runDir, {
    nativeGateways: {
      vaultProxy,
    },
    rolesBootstrap: {
      vaultProxy,
    },
    strategyCore: {
      vaultProxy,
    },
    vaultTokenConfig: {
      vaultProxy,
    },
    vaultTokenStrategy: {
      vaultProxy,
    },
    yieldRecipientBootstrap: {
      vaultProxy,
    },
  });
}

function recordStrategyProxy(
  manifest: DeploymentManifest,
  runDir: string,
  resolvedParams: ResolvedParams,
  strategyProxy: Address,
) {
  resolvedParams.vaultTokenStrategy.strategyProxy = strategyProxy;
  mergeManifestResolvedSections(manifest, runDir, {
    vaultTokenStrategy: {
      strategyProxy,
    },
  });
}

function saveCommandLogs(
  runDir: string,
  logBaseName: string,
  output: Pick<CommandResult, "stderr" | "stdout">,
): { stderr: string; stdout: string } {
  const logsDir = join(runDir, "logs");
  ensureDir(logsDir);
  const stdoutPath = join(logsDir, `${logBaseName}.stdout.log`);
  const stderrPath = join(logsDir, `${logBaseName}.stderr.log`);
  writeFileSync(stdoutPath, output.stdout);
  writeFileSync(stderrPath, output.stderr);
  return { stderr: stderrPath, stdout: stdoutPath };
}

async function withTemporaryParamsFile<T>(
  fileName: string,
  payload: unknown,
  callback: (paramsPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), "defivault-initial-stack-"));
  const paramsPath = join(tempDir, fileName);
  writeJson5(paramsPath, payload);
  try {
    return await callback(paramsPath);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

async function runIgnitionStep(args: {
  deploymentId: string;
  manifest: DeploymentManifest;
  modulePath: string;
  modulePayload: JsonRecord;
  moduleRootKey: string;
  networkName: string;
  paramsFileName: string;
  repeatStepConfirmations: boolean;
  runDir: string;
  stepName: string;
  summaryAddresses?: (
    deployed: Record<string, string>,
  ) => Promise<Record<string, string>>;
  summaryNotes?: string[];
  nextAction: string;
}): Promise<Record<string, string>> {
  await confirmStep(
    args.stepName,
    args.nextAction,
    args.repeatStepConfirmations,
  );
  const commandText = deploymentCommandText(
    args.modulePath,
    args.paramsFileName,
    args.deploymentId,
    args.networkName,
  );
  console.log(chalk.dim(commandText));

  const startedAt = nowIso();
  const step: StepRecord = {
    command: commandText,
    name: args.stepName,
    nextAction: args.nextAction,
    notes: args.summaryNotes,
    startedAt,
    status: "pending",
  };
  pushStep(args.manifest, step, args.runDir);
  const spinner = ora({
    discardStdin: false,
    text: `${emoji.get("rocket")} ${args.stepName} in progress...`,
  }).start();
  const startedAtMs = Date.now();

  const result = await withTemporaryParamsFile(
    args.paramsFileName,
    { [args.moduleRootKey]: args.modulePayload },
    (paramsPath) =>
      runCommand(
        "npx",
        [
          "hardhat",
          "ignition",
          "deploy",
          args.modulePath,
          "--network",
          args.networkName,
          "--parameters",
          paramsPath,
          "--deployment-id",
          args.deploymentId,
          "--reset",
        ],
        {
          HARDHAT_IGNITION_CONFIRM_DEPLOYMENT: "true",
          HARDHAT_IGNITION_CONFIRM_RESET: "true",
        },
      ),
  );

  if (result.code !== 0) {
    spinner.fail(`${emoji.get("x")} ${args.stepName} failed`);
    const hint = classifyFailureHint(`${result.stdout}\n${result.stderr}`);
    const logFiles = saveCommandLogs(args.runDir, args.paramsFileName, result);
    step.duration = formatDuration(Date.now() - startedAtMs);
    step.completedAt = nowIso();
    step.logFiles = logFiles;
    step.notes = [
      ...(step.notes ?? []),
      "Hardhat Ignition returned a non-zero exit code.",
      "Inspect the saved stdout/stderr logs for the full failure context.",
      ...(hint === undefined ? [] : [`Hint: ${hint}`]),
    ];
    step.status = "aborted";
    updateStep(args.manifest, step, args.runDir);
    if (hint !== undefined) {
      console.log(chalk.yellow(`  hint: ${hint}`));
    }
    throw new Error(
      `${args.stepName} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  try {
    const deployed = readIgnitionDeployedAddresses(args.deploymentId);
    const summaryAddresses =
      args.summaryAddresses === undefined
        ? {}
        : await args.summaryAddresses(deployed);

    spinner.succeed(
      `${emoji.get("white_check_mark")} ${args.stepName} complete (${formatDuration(
        Date.now() - startedAtMs,
      )})`,
    );
    step.addresses = summaryAddresses;
    step.duration = formatDuration(Date.now() - startedAtMs);
    step.completedAt = nowIso();
    step.status = "completed";
    updateStep(args.manifest, step, args.runDir);

    if (Object.keys(summaryAddresses).length > 0) {
      for (const [name, address] of Object.entries(summaryAddresses)) {
        console.log(chalk.green(`  ${name}: ${address}`));
      }
    }
    return deployed;
  } catch (error) {
    spinner.fail(`${emoji.get("x")} ${args.stepName} failed`);
    const hint = classifyFailureHint(
      error instanceof Error ? error.message : String(error),
    );
    const logFiles = saveCommandLogs(args.runDir, args.paramsFileName, result);
    step.duration = formatDuration(Date.now() - startedAtMs);
    step.completedAt = nowIso();
    step.logFiles = logFiles;
    step.notes = [
      ...(step.notes ?? []),
      error instanceof Error ? error.message : String(error),
      ...(hint === undefined ? [] : [`Hint: ${hint}`]),
    ];
    step.status = "aborted";
    updateStep(args.manifest, step, args.runDir);
    if (hint !== undefined) {
      console.log(chalk.yellow(`  hint: ${hint}`));
    }
    throw error;
  }
}

async function runVerificationStep(args: {
  manifest: DeploymentManifest;
  repeatStepConfirmations: boolean;
  runDir: string;
}) {
  const stepName = "Explorer verification";
  const nextAction =
    "Verify the freshly deployed contracts against the configured explorers and persist the verification logs.";

  await confirmStep(stepName, nextAction, args.repeatStepConfirmations);
  const commandText = verificationCommandText(args.runDir);
  console.log(chalk.dim(commandText));

  const step: StepRecord = {
    command: commandText,
    name: stepName,
    nextAction,
    notes: [
      "Uses the saved run record to verify each Ignition deployment ID plus the transparent-proxy ProxyAdmin contracts.",
      ...(process.env.ETHERSCAN_API_KEY === undefined
        ? [
            "ETHERSCAN_API_KEY is not set; Hardhat will only use other enabled explorers such as Sourcify.",
          ]
        : []),
    ],
    startedAt: nowIso(),
    status: "pending",
  };
  pushStep(args.manifest, step, args.runDir);
  const spinner = ora({
    discardStdin: false,
    text: `${emoji.get("mag")} ${stepName} in progress...`,
  }).start();
  const startedAtMs = Date.now();

  const result = await runCommand("npx", [
    "tsx",
    "./scripts/verify/verify-initial-stack.ts",
    "--run-dir",
    args.runDir,
  ]);

  if (result.code !== 0) {
    spinner.fail(`${emoji.get("x")} ${stepName} failed`);
    const logFiles = saveCommandLogs(
      args.runDir,
      "verify-initial-stack",
      result,
    );
    step.duration = formatDuration(Date.now() - startedAtMs);
    step.completedAt = nowIso();
    step.logFiles = logFiles;
    step.notes = [
      ...(step.notes ?? []),
      "Verification returned a non-zero exit code.",
      "Fix the explorer prerequisites and rerun `npm run verify:initial-stack -- --run-dir <runDir>`.",
    ];
    step.status = "aborted";
    updateStep(args.manifest, step, args.runDir);
    throw new Error(
      `${stepName} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  spinner.succeed(
    `${emoji.get("white_check_mark")} ${stepName} complete (${formatDuration(
      Date.now() - startedAtMs,
    )})`,
  );
  step.duration = formatDuration(Date.now() - startedAtMs);
  step.completedAt = nowIso();
  step.status = "completed";
  updateStep(args.manifest, step, args.runDir);
}

type AavePrerequisiteStepArgs = {
  aaveMode: AaveMode;
  grvtEnvironment: GrvtEnvironment;
  localMode: boolean;
  manifest: DeploymentManifest;
  networkName: string;
  publicClient: PublicClient;
  repeatStepConfirmations: boolean;
  resolvedParams: ResolvedParams;
  runDir: string;
};

function aavePrerequisiteDescription(args: AavePrerequisiteStepArgs): string {
  if (args.localMode) {
    return "This reuses MockAaveV3Pool and MockAaveV3AToken from the smoke artifacts, then verifies the linkage.";
  }

  if (args.aaveMode === "mock-aave") {
    return "This deploys MockAaveV3Pool and MockAaveV3AToken for the supplied underlying token, then verifies the linkage.";
  }

  return "This validates the configured live Aave pool and aToken before deploying the strategy.";
}

function requireAavePrerequisiteAddresses(args: {
  aToken?: Address;
  aavePool?: Address;
  errorMessage: string;
}) {
  if (args.aavePool === undefined || args.aToken === undefined) {
    throw new Error(args.errorMessage);
  }

  return {
    aTokenAddress: args.aToken,
    aavePoolAddress: args.aavePool,
  };
}

async function reuseLocalAavePrerequisites(args: AavePrerequisiteStepArgs) {
  await confirmStep(
    "Mock Aave prerequisite reuse",
    "Validate the predeployed pool and aToken from the smoke artifacts, then write their addresses into the generated run params.",
    args.repeatStepConfirmations,
  );

  const prereqStep: StepRecord = {
    name: "Mock Aave prerequisite reuse",
    nextAction:
      "Use the deployed pool and aToken for strategy-core and downstream steps.",
    notes: [
      `underlyingToken=${args.resolvedParams.strategyCore.underlyingToken}`,
      `aavePool=${args.resolvedParams.strategyCore.aavePool}`,
      `aToken=${args.resolvedParams.strategyCore.aToken}`,
      `aTokenName=${args.resolvedParams.aTokenName}`,
      `aTokenSymbol=${args.resolvedParams.aTokenSymbol}`,
    ],
    startedAt: nowIso(),
    status: "pending",
  };
  pushStep(args.manifest, prereqStep, args.runDir);

  const prereqSpinner = ora({
    discardStdin: false,
    text: `${emoji.get("construction")} Validating smoke prerequisite contracts...`,
  }).start();
  const startedAtMs = Date.now();

  try {
    const { aTokenAddress, aavePoolAddress } = requireAavePrerequisiteAddresses(
      {
        aToken: args.resolvedParams.strategyCore.aToken,
        aavePool: args.resolvedParams.strategyCore.aavePool,
        errorMessage: "local mode requires smoke prerequisite addresses",
      },
    );

    await validateAaveStrategyPrerequisites({
      aTokenAddress,
      aaveMode: "mock-aave",
      aavePoolAddress,
      publicClient: args.publicClient,
      underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
    });

    prereqSpinner.succeed(
      `${emoji.get("sparkles")} Mock Aave prerequisites reused (${formatDuration(
        Date.now() - startedAtMs,
      )})`,
    );
    prereqStep.addresses = {
      aToken: aTokenAddress,
      aavePool: aavePoolAddress,
      underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
    };
    prereqStep.duration = formatDuration(Date.now() - startedAtMs);
    prereqStep.completedAt = nowIso();
    prereqStep.status = "completed";
    updateStep(args.manifest, prereqStep, args.runDir);
    console.log(chalk.green(`  aavePool: ${aavePoolAddress}`));
    console.log(chalk.green(`  aToken: ${aTokenAddress}`));

    recordResolvedPrerequisites(
      args.manifest,
      args.runDir,
      args.resolvedParams,
      args.resolvedParams.strategyCore.underlyingToken,
      aavePoolAddress,
      aTokenAddress,
    );
  } catch (error) {
    prereqSpinner.fail(`${emoji.get("x")} Mock Aave prerequisite reuse failed`);
    prereqStep.duration = formatDuration(Date.now() - startedAtMs);
    prereqStep.completedAt = nowIso();
    prereqStep.notes = [
      ...(prereqStep.notes ?? []),
      error instanceof Error ? error.message : String(error),
    ];
    prereqStep.status = "aborted";
    updateStep(args.manifest, prereqStep, args.runDir);
    throw error;
  }
}

async function deployMockAavePrerequisites(args: AavePrerequisiteStepArgs) {
  const deployed = await runIgnitionStep({
    deploymentId: `initial-${args.grvtEnvironment}-mock-aave-prerequisites-${args.manifest.runId}`,
    manifest: args.manifest,
    modulePath: "./ignition/modules/MockAavePrerequisites.ts",
    modulePayload: {
      underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
      aTokenName: args.resolvedParams.aTokenName,
      aTokenSymbol: args.resolvedParams.aTokenSymbol,
    },
    moduleRootKey: "MockAavePrerequisitesModule",
    networkName: args.networkName,
    nextAction:
      "Use the deployed pool and aToken for strategy-core and downstream steps.",
    paramsFileName: "mock-aave-prerequisites.generated.json5",
    repeatStepConfirmations: args.repeatStepConfirmations,
    runDir: args.runDir,
    stepName: "Mock Aave prerequisite deployment",
    summaryAddresses: async (deployment) => {
      const aavePoolAddress = normalizeAddress(
        deployment["MockAavePrerequisitesModule#MockAavePool"],
      );
      const aTokenAddress = normalizeAddress(
        deployment["MockAavePrerequisitesModule#MockAaveAToken"],
      );

      await validateAaveStrategyPrerequisites({
        aTokenAddress,
        aaveMode: "mock-aave",
        aavePoolAddress,
        publicClient: args.publicClient,
        underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
      });

      return {
        aToken: aTokenAddress,
        aavePool: aavePoolAddress,
        underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
      };
    },
    summaryNotes: [
      `underlyingToken=${args.resolvedParams.strategyCore.underlyingToken}`,
      `aTokenName=${args.resolvedParams.aTokenName}`,
      `aTokenSymbol=${args.resolvedParams.aTokenSymbol}`,
    ],
  });

  const aavePoolAddress = normalizeAddress(
    deployed["MockAavePrerequisitesModule#MockAavePool"],
  );
  const aTokenAddress = normalizeAddress(
    deployed["MockAavePrerequisitesModule#MockAaveAToken"],
  );

  recordResolvedPrerequisites(
    args.manifest,
    args.runDir,
    args.resolvedParams,
    args.resolvedParams.strategyCore.underlyingToken,
    aavePoolAddress,
    aTokenAddress,
  );
}

async function validateLiveAavePrerequisites(args: AavePrerequisiteStepArgs) {
  await confirmStep(
    "Live Aave prerequisite validation",
    "Validate the configured Aave pool and aToken before deploying the strategy.",
    args.repeatStepConfirmations,
  );

  const prereqStep: StepRecord = {
    name: "Live Aave prerequisite validation",
    nextAction:
      "Use the validated pool and aToken for strategy-core and downstream steps.",
    notes: [
      `underlyingToken=${args.resolvedParams.strategyCore.underlyingToken}`,
      `aavePool=${args.resolvedParams.strategyCore.aavePool}`,
      `aToken=${args.resolvedParams.strategyCore.aToken}`,
    ],
    startedAt: nowIso(),
    status: "pending",
  };
  pushStep(args.manifest, prereqStep, args.runDir);

  const prereqSpinner = ora({
    discardStdin: false,
    text: `${emoji.get("construction")} Validating configured live Aave contracts...`,
  }).start();
  const startedAtMs = Date.now();

  try {
    const { aTokenAddress, aavePoolAddress } = requireAavePrerequisiteAddresses(
      {
        aToken: args.resolvedParams.strategyCore.aToken,
        aavePool: args.resolvedParams.strategyCore.aavePool,
        errorMessage:
          "live Aave mode requires configured aavePool and aToken addresses",
      },
    );

    await validateAaveStrategyPrerequisites({
      aTokenAddress,
      aaveMode: "live-aave",
      aavePoolAddress,
      publicClient: args.publicClient,
      underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
    });

    prereqSpinner.succeed(
      `${emoji.get("sparkles")} Live Aave prerequisites validated (${formatDuration(
        Date.now() - startedAtMs,
      )})`,
    );
    prereqStep.addresses = {
      aToken: aTokenAddress,
      aavePool: aavePoolAddress,
      underlyingToken: args.resolvedParams.strategyCore.underlyingToken,
    };
    prereqStep.duration = formatDuration(Date.now() - startedAtMs);
    prereqStep.completedAt = nowIso();
    prereqStep.status = "completed";
    updateStep(args.manifest, prereqStep, args.runDir);
    console.log(chalk.green(`  aavePool: ${aavePoolAddress}`));
    console.log(chalk.green(`  aToken: ${aTokenAddress}`));

    recordResolvedPrerequisites(
      args.manifest,
      args.runDir,
      args.resolvedParams,
      args.resolvedParams.strategyCore.underlyingToken,
      aavePoolAddress,
      aTokenAddress,
    );
  } catch (error) {
    prereqSpinner.fail(
      `${emoji.get("x")} Live Aave prerequisite validation failed`,
    );
    const hint = classifyFailureHint(
      error instanceof Error ? error.message : String(error),
    );
    prereqStep.duration = formatDuration(Date.now() - startedAtMs);
    prereqStep.completedAt = nowIso();
    prereqStep.notes = [
      ...(prereqStep.notes ?? []),
      error instanceof Error ? error.message : String(error),
      ...(hint === undefined ? [] : [`Hint: ${hint}`]),
    ];
    prereqStep.status = "aborted";
    updateStep(args.manifest, prereqStep, args.runDir);
    if (hint !== undefined) {
      console.log(chalk.yellow(`  hint: ${hint}`));
    }
    throw error;
  }
}

async function runAavePrerequisiteStep(args: AavePrerequisiteStepArgs) {
  renderSection(
    stepLabel(1, "Aave Strategy Prerequisites"),
    aavePrerequisiteDescription(args),
  );
  if (args.localMode) {
    await reuseLocalAavePrerequisites(args);
    return;
  }

  if (args.aaveMode === "mock-aave") {
    await deployMockAavePrerequisites(args);
    return;
  }

  await validateLiveAavePrerequisites(args);
}

async function main() {
  try {
    const currentNetwork = runtimeNetworkName();
    const localMode = isLocalMode(currentNetwork);
    const grvtEnvironment = await resolveGrvtEnvironment(localMode);
    const aaveMode = aaveModeForEnvironment(grvtEnvironment);
    const parameterDir = parameterDirForEnvironment(grvtEnvironment);
    const runId = makeRunId();
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    const wallets = await viem.getWalletClients();
    if (wallets.length === 0 || wallets[0].account === undefined) {
      throw new Error(
        `${currentNetwork} network has no deployer wallet configured`,
      );
    }

    const deployer = normalizeAddress(wallets[0].account.address);
    const chainId = await publicClient.getChainId();
    const displayNetwork = networkDisplayName(currentNetwork, chainId);
    const runDir = initialStackRunDir(repoRoot, grvtEnvironment, runId);
    ensureDir(runDir);

    console.log(
      chalk.bold.green(
        `${emoji.get("tada")} Interactive initial DefiVault stack deployment`,
      ),
    );
    console.log(chalk.dim(`Run directory: ${relativePath(runDir)}`));
    console.log(chalk.dim(`GRVT environment: ${grvtEnvironment}`));
    console.log(chalk.dim(`Target network: ${displayNetwork}`));
    console.log(chalk.dim(`Aave mode: ${aaveModeLabel(aaveMode)}`));
    if (displayNetwork !== currentNetwork) {
      console.log(chalk.dim(`Hardhat network alias: ${currentNetwork}`));
    }
    console.log(
      chalk.dim(
        "This script pauses before every deploy step and only writes the saved run record after deployment finishes.",
      ),
    );
    await runPreflight({
      aaveMode,
      chainId,
      deployer,
      displayNetwork,
      grvtEnvironment,
      localMode,
      parameterDir,
      publicClient,
    });
    const resolvedParams = await promptResolvedParams({
      aaveMode,
      deployerAddress: deployer,
      grvtEnvironment,
      localMode,
      parameterDir,
      publicClient,
    });
    renderResolvedConfig({
      aaveMode,
      grvtEnvironment,
      parameterDir,
      params: resolvedParams,
    });
    const repeatStepConfirmations = await askConfirm(
      "Require confirmation before every deployment step?",
      grvtEnvironment === "production",
    );
    console.log(
      chalk.dim(
        `Per-step confirmations: ${repeatStepConfirmations ? "enabled" : "disabled"}`,
      ),
    );
    const runPostDeployVerification = localMode
      ? false
      : await askConfirm(
          "Run explorer verification automatically after the deployment steps finish?",
          true,
        );
    console.log(
      chalk.dim(
        localMode
          ? "Automatic explorer verification: disabled for localhost runs."
          : `Automatic explorer verification: ${runPostDeployVerification ? "enabled" : "disabled"}`,
      ),
    );

    const startConfirmed = await askConfirm(
      "Start the interactive deployment with these settings?",
      true,
    );
    if (!startConfirmed) {
      throw new UserAbortError("aborted before deployment started");
    }

    const manifest = createInitialManifest(
      aaveMode,
      grvtEnvironment,
      localMode,
      parameterDir,
      repeatStepConfirmations,
      runPostDeployVerification,
      runId,
      runDir,
      currentNetwork,
      displayNetwork,
      chainId,
      deployer,
      resolvedParams,
    );
    if (localMode) {
      manifest.sourceParameterFiles.localSmokePrerequisites =
        smokePrerequisitesPath;
    }
    await runAavePrerequisiteStep({
      aaveMode,
      grvtEnvironment,
      localMode,
      manifest,
      networkName: currentNetwork,
      publicClient,
      repeatStepConfirmations,
      resolvedParams,
      runDir,
    });

    renderSection(
      stepLabel(2, "Vault Core"),
      "Deploy the vault implementation and proxy, then read back the ProxyAdmin address from the EIP-1967 slot.",
    );
    const vaultCoreDeployed = await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-vault-core-${runId}`,
      manifest,
      modulePath: "./ignition/modules/VaultCore.ts",
      modulePayload: {
        ...resolvedParams.vaultCore,
        l2ChainId: bigintText(resolvedParams.vaultCore.l2ChainId),
      },
      moduleRootKey: "VaultCoreModule",
      networkName: currentNetwork,
      nextAction:
        "Use the vault proxy address to wire strategy-core, token config, roles, timelock, and native gateways.",
      paramsFileName: "vault-core.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Vault core deployment",
      summaryAddresses: async (deployed) => {
        const vaultProxy = normalizeAddress(
          deployed["VaultCoreModule#VaultProxy"],
        );
        const vaultImplementation = normalizeAddress(
          deployed["VaultCoreModule#VaultImplementation"],
        );
        const vaultProxyAdmin = await readProxyAdminAddress(
          publicClient,
          vaultProxy,
        );
        return {
          vaultImplementation,
          vaultProxy,
          vaultProxyAdmin,
        };
      },
      summaryNotes: [
        `yieldRecipient=${resolvedParams.vaultCore.yieldRecipient}`,
        `wrappedNativeToken=${resolvedParams.vaultCore.wrappedNativeToken}`,
      ],
    });
    const vaultProxy = normalizeAddress(
      vaultCoreDeployed["VaultCoreModule#VaultProxy"],
    );
    recordVaultProxy(manifest, runDir, resolvedParams, vaultProxy);

    renderSection(
      stepLabel(3, "Strategy Core"),
      aaveMode === "mock-aave"
        ? "Deploy the AaveV3Strategy proxy bound to the mock pool, underlying token, and mock aToken."
        : "Deploy the AaveV3Strategy proxy bound to the validated live Aave pool, underlying token, and aToken.",
    );
    const strategyCoreDeployed = await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-strategy-core-${runId}`,
      manifest,
      modulePath: "./ignition/modules/StrategyCore.ts",
      modulePayload: {
        aToken: resolvedParams.strategyCore.aToken,
        aavePool: resolvedParams.strategyCore.aavePool,
        proxyAdminOwner: resolvedParams.strategyCore.proxyAdminOwner,
        strategyName: resolvedParams.strategyCore.strategyName,
        underlyingToken: resolvedParams.strategyCore.underlyingToken,
        vaultProxy: resolvedParams.strategyCore.vaultProxy,
      },
      moduleRootKey: "StrategyCoreModule",
      networkName: currentNetwork,
      nextAction:
        "Use the strategy proxy to configure vault-token strategy support and whitelist state.",
      paramsFileName: "strategy-core.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Strategy core deployment",
      summaryAddresses: async (deployed) => {
        const strategyProxy = normalizeAddress(
          deployed["StrategyCoreModule#StrategyProxy"],
        );
        const strategyImplementation = normalizeAddress(
          deployed["StrategyCoreModule#StrategyImplementation"],
        );
        const strategyProxyAdmin = await readProxyAdminAddress(
          publicClient,
          strategyProxy,
        );
        return {
          strategyImplementation,
          strategyProxy,
          strategyProxyAdmin,
        };
      },
      summaryNotes: [
        `aavePool=${resolvedParams.strategyCore.aavePool}`,
        `aToken=${resolvedParams.strategyCore.aToken}`,
      ],
    });
    const strategyProxy = normalizeAddress(
      strategyCoreDeployed["StrategyCoreModule#StrategyProxy"],
    );
    recordStrategyProxy(manifest, runDir, resolvedParams, strategyProxy);

    renderSection(
      stepLabel(4, "Vault Token Support"),
      "Enable the chosen underlying token as a supported vault token.",
    );
    await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-vault-token-config-${runId}`,
      manifest,
      modulePath: "./ignition/modules/VaultTokenConfig.ts",
      modulePayload: {
        supported: resolvedParams.vaultTokenConfig.supported,
        vaultProxy: resolvedParams.vaultTokenConfig.vaultProxy,
        vaultToken: resolvedParams.vaultTokenConfig.vaultToken,
      },
      moduleRootKey: "VaultTokenConfigModule",
      networkName: currentNetwork,
      nextAction:
        "Whitelist the strategy against this token and set the initial cap.",
      paramsFileName: "vault-token-config.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Vault token configuration",
      summaryNotes: [
        `vaultToken=${resolvedParams.vaultTokenConfig.vaultToken}`,
        `supported=${String(resolvedParams.vaultTokenConfig.supported)}`,
      ],
    });

    renderSection(
      stepLabel(5, "Vault Token Strategy Binding"),
      "Apply token support plus strategy whitelist/cap in a single deterministic Ignition run.",
    );
    await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-vault-token-strategy-${runId}`,
      manifest,
      modulePath: "./ignition/modules/VaultTokenStrategy.ts",
      modulePayload: {
        strategyCap: bigintText(resolvedParams.vaultTokenStrategy.strategyCap),
        strategyProxy: resolvedParams.vaultTokenStrategy.strategyProxy,
        vaultProxy: resolvedParams.vaultTokenStrategy.vaultProxy,
        vaultToken: resolvedParams.vaultTokenStrategy.vaultToken,
        vaultTokenStrategyWhitelisted:
          resolvedParams.vaultTokenStrategy.vaultTokenStrategyWhitelisted,
        vaultTokenSupported:
          resolvedParams.vaultTokenStrategy.vaultTokenSupported,
      },
      moduleRootKey: "VaultTokenStrategyModule",
      networkName: currentNetwork,
      nextAction: "Grant operator roles so the environment can be exercised.",
      paramsFileName: "vault-token-strategy.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Vault token strategy configuration",
      summaryNotes: [
        `strategyCap=${strategyCapText(resolvedParams.vaultTokenStrategy.strategyCap)}`,
        `strategyProxy=${resolvedParams.vaultTokenStrategy.strategyProxy}`,
      ],
    });

    renderSection(
      stepLabel(6, "Roles Bootstrap"),
      "Grant allocator, rebalancer, and pauser roles to the configured operators.",
    );
    await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-roles-${runId}`,
      manifest,
      modulePath: "./ignition/modules/VaultRolesBootstrap.ts",
      modulePayload: {
        allocator: resolvedParams.rolesBootstrap.allocator,
        pauser: resolvedParams.rolesBootstrap.pauser,
        rebalancer: resolvedParams.rolesBootstrap.rebalancer,
        vaultProxy: resolvedParams.rolesBootstrap.vaultProxy,
      },
      moduleRootKey: "VaultRolesBootstrapModule",
      networkName: currentNetwork,
      nextAction:
        "Bootstrap the yield-recipient timelock controller for governance exercises.",
      paramsFileName: "roles-bootstrap.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Roles bootstrap",
      summaryNotes: [
        `allocator=${resolvedParams.rolesBootstrap.allocator}`,
        `rebalancer=${resolvedParams.rolesBootstrap.rebalancer}`,
        `pauser=${resolvedParams.rolesBootstrap.pauser}`,
      ],
    });

    renderSection(
      stepLabel(7, "Yield Recipient Timelock"),
      "Deploy the timelock controller and set it on the vault.",
    );
    await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-yield-recipient-timelock-${runId}`,
      manifest,
      modulePath: "./ignition/modules/VaultYieldRecipientTimelock.ts",
      modulePayload: {
        admin: resolvedParams.yieldRecipientBootstrap.admin,
        executors: resolvedParams.yieldRecipientBootstrap.executors,
        minDelay: bigintText(resolvedParams.yieldRecipientBootstrap.minDelay),
        proposers: resolvedParams.yieldRecipientBootstrap.proposers,
        vaultProxy: resolvedParams.yieldRecipientBootstrap.vaultProxy,
      },
      moduleRootKey: "VaultYieldRecipientTimelockModule",
      networkName: currentNetwork,
      nextAction:
        "Deploy the native gateways and wire the NativeBridgeGateway into the vault.",
      paramsFileName: "yield-recipient-bootstrap.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Yield recipient timelock bootstrap",
      summaryAddresses: async (deployed) => {
        const candidates = Object.values(deployed)
          .filter((value): value is string => isAddress(value))
          .map((value) => normalizeAddress(value));
        const timelockAddress = candidates.find(
          (address) => !sameAddress(address, vaultProxy),
        );
        if (timelockAddress === undefined) {
          throw new Error(
            "timelock deployment did not surface a new contract address",
          );
        }
        return {
          yieldRecipientTimelockController: timelockAddress,
        };
      },
      summaryNotes: [
        `minDelay=${bigintText(resolvedParams.yieldRecipientBootstrap.minDelay)}`,
      ],
    });

    renderSection(
      stepLabel(8, "Native Gateways"),
      "Deploy NativeVaultGateway plus the NativeBridgeGateway proxy and attach it to the vault.",
    );
    await runIgnitionStep({
      deploymentId: `initial-${grvtEnvironment}-native-gateways-${runId}`,
      manifest,
      modulePath: "./ignition/modules/NativeGateways.ts",
      modulePayload: {
        bridgeHub: resolvedParams.nativeGateways.bridgeHub,
        grvtBridgeProxyFeeToken:
          resolvedParams.nativeGateways.grvtBridgeProxyFeeToken,
        proxyAdminOwner: resolvedParams.nativeGateways.proxyAdminOwner,
        vaultProxy: resolvedParams.nativeGateways.vaultProxy,
        wrappedNativeToken: resolvedParams.nativeGateways.wrappedNativeToken,
      },
      moduleRootKey: "NativeGatewaysModule",
      networkName: currentNetwork,
      nextAction:
        "Review the saved record, inspect the saved artifacts, and run your preferred post-deploy smoke checks.",
      paramsFileName: "native-gateways.generated.json5",
      repeatStepConfirmations,
      runDir,
      stepName: "Native gateways deployment",
      summaryAddresses: async (deployed) => {
        const nativeVaultGateway = normalizeAddress(
          deployed["NativeGatewaysModule#NativeVaultGateway"],
        );
        const nativeBridgeGatewayImplementation = normalizeAddress(
          deployed["NativeGatewaysModule#NativeBridgeGatewayImplementation"],
        );
        const nativeBridgeGatewayProxy = normalizeAddress(
          deployed["NativeGatewaysModule#NativeBridgeGatewayProxy"],
        );
        const nativeBridgeGatewayProxyAdmin = await readProxyAdminAddress(
          publicClient,
          nativeBridgeGatewayProxy,
        );
        return {
          nativeBridgeGatewayImplementation,
          nativeBridgeGatewayProxy,
          nativeBridgeGatewayProxyAdmin,
          nativeVaultGateway,
        };
      },
      summaryNotes: [
        `wrappedNativeToken=${resolvedParams.nativeGateways.wrappedNativeToken}`,
        `bridgeHub=${resolvedParams.nativeGateways.bridgeHub}`,
      ],
    });

    if (grvtEnvironment === "production") {
      console.log(
        chalk.yellow(
          `${emoji.get("warning")} Production bootstrap is awaiting admin handoff before this run is considered complete.`,
        ),
      );
      console.log(
        chalk.white(
          `Next step: npx hardhat ops:production-admin-handoff --network ${currentNetwork} --record ${relativePath(runDir)}`,
        ),
      );
    }

    persistManifest(runDir, manifest);

    if (runPostDeployVerification) {
      renderSection(
        "Explorer Verification",
        "Verify every deployed contract from this saved run against the configured explorers.",
      );
      await runVerificationStep({
        manifest,
        repeatStepConfirmations,
        runDir,
      });
    }

    persistManifest(runDir, manifest);

    renderSection(
      "Deployment Complete",
      "The run directory contains the canonical record. Raw command logs are only saved when a step fails.",
    );
    console.log(
      chalk.green(
        `${emoji.get("confetti_ball")} Initial stack deployment completed successfully.`,
      ),
    );
    console.log(chalk.white(`Artifacts: ${relativePath(runDir)}`));
    console.log(
      chalk.white(`Record: ${relativePath(join(runDir, "record.json"))}`),
    );
    console.log(
      chalk.dim(
        grvtEnvironment === "production"
          ? "Suggested next step: run ops:production-admin-handoff against this record, then run verification and manual smoke checks."
          : runPostDeployVerification
            ? "Suggested next step: review record.json and verification logs, then run your manual funding/allocation smoke checks."
            : "Suggested next step: review record.json, optionally run `npm run verify:initial-stack -- --run-dir <runDir>`, then run your manual funding/allocation smoke checks.",
      ),
    );
  } catch (error) {
    if (error instanceof UserAbortError) {
      console.log(
        chalk.yellow(`${emoji.get("pause_button")} ${error.message}`),
      );
      console.log(
        chalk.dim(
          "No resumable run record was written; in-memory progress was discarded.",
        ),
      );
      return;
    }
    throw error;
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(
    chalk.red(
      `${emoji.get("boom")} Interactive initial stack deployment failed.`,
    ),
  );
  const hint = classifyFailureHint(
    error instanceof Error ? error.message : String(error),
  );
  if (hint !== undefined) {
    console.error(chalk.yellow(`hint: ${hint}`));
  }
  console.error(error);
  process.exitCode = 1;
});
