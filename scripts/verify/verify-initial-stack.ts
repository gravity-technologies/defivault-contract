#!/usr/bin/env node

import "dotenv/config";

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import * as emoji from "node-emoji";
import ora from "ora";
import { encodeFunctionData, parseAbi } from "viem";
import { initialStackArtifactsRoot } from "../deploy/initial-stack-artifacts.js";

/**
 * Initial-stack deployment verifier.
 *
 * Flow:
 * - Resolve one saved initial-stack run from `ignition/deployments/initial-stack/`.
 * - Read the persisted manifest plus each step's Ignition `deployed_addresses.json`.
 * - Reconstruct constructor arguments and library addresses from the saved run state.
 * - Write temporary ESM modules under `<runDir>/verify-inputs/` for Hardhat's
 *   `--constructor-args-path` and `--libraries-path` flags.
 * - Verify each deployable contract explicitly in a deterministic order.
 *
 * Important nuances:
 * - This script intentionally does not rely on `hardhat ignition verify` for
 *   proxy-bearing OZ deployments. Those deployments were created from packaged
 *   OpenZeppelin artifacts, and the artifact/build-info naming inside Ignition
 *   does not line up cleanly with Hardhat Verify's project artifact lookup.
 * - Instead, the script verifies proxies, ProxyAdmin contracts, TimelockController,
 *   libraries, and implementations explicitly using reconstructed constructor
 *   args and library maps.
 * - Packaged OZ sources still need to exist in the Hardhat artifact graph, so
 *   `hardhat.config.ts` builds those npm sources with the compiler versions used
 *   at deployment time.
 * - Provider selection is explicit: default to `etherscan` when
 *   `ETHERSCAN_API_KEY` is available, otherwise use `sourcify`.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const INITIAL_STACK_ARTIFACTS_DIR = initialStackArtifactsRoot(REPO_ROOT);
const VERIFY_INPUTS_DIRNAME = "verify-inputs";
const MOCK_AAVE_POOL_CONTRACT =
  "contracts/mocks/MockAaveV3Pool.sol:MockAaveV3Pool";
const MOCK_AAVE_ATOKEN_CONTRACT =
  "contracts/mocks/MockAaveV3AToken.sol:MockAaveV3AToken";
const VAULT_STRATEGY_OPS_LIB_CONTRACT =
  "contracts/vault/VaultStrategyOpsLib.sol:VaultStrategyOpsLib";
const VAULT_BRIDGE_LIB_CONTRACT =
  "contracts/vault/VaultBridgeLib.sol:VaultBridgeLib";
const VAULT_IMPLEMENTATION_CONTRACT =
  "contracts/vault/GRVTL1TreasuryVault.sol:GRVTL1TreasuryVault";
const STRATEGY_IMPLEMENTATION_CONTRACT =
  "contracts/strategies/AaveV3Strategy.sol:AaveV3Strategy";
const NATIVE_VAULT_GATEWAY_CONTRACT =
  "contracts/gateways/NativeVaultGateway.sol:NativeVaultGateway";
const NATIVE_BRIDGE_GATEWAY_CONTRACT =
  "contracts/gateways/NativeBridgeGateway.sol:NativeBridgeGateway";
const TIMELOCK_CONTROLLER_CONTRACT =
  "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController";
const TRANSPARENT_PROXY_CONTRACT =
  "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy";
const PROXY_ADMIN_CONTRACT =
  "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin";
const SECTION_DIVIDER = chalk.blue("=".repeat(72));
const VAULT_INITIALIZE_ABI = parseAbi([
  "function initialize(address deployAdmin,address bridgeHub,address grvtBridgeProxyFeeToken,uint256 l2ChainId,address l2ExchangeRecipient,address wrappedNativeToken,address yieldRecipient)",
]);
const STRATEGY_INITIALIZE_ABI = parseAbi([
  "function initialize(address vaultProxy,address aavePool,address underlyingToken,address aToken,string strategyName)",
]);
const NATIVE_BRIDGE_GATEWAY_INITIALIZE_ABI = parseAbi([
  "function initialize(address wrappedNativeToken,address grvtBridgeProxyFeeToken,address bridgeHub,address vaultProxy)",
]);

type VerificationProvider = "etherscan" | "sourcify";
type VerificationKind = "contract" | "proxy-admin" | "ignition";

interface CliOptions {
  dryRun: boolean;
  force: boolean;
  grvtEnv?: string;
  latest: boolean;
  network?: string;
  provider?: VerificationProvider;
  runDir?: string;
  runId?: string;
}

interface ManifestStep {
  addresses?: Record<string, string | undefined>;
  command?: string;
  name: string;
}

interface Manifest {
  environment: {
    grvtEnv: string;
  };
  network: {
    alias: string;
    chainId: number | string;
  };
  resolvedParams: any;
  runId: string;
  steps: ManifestStep[];
}

type ModuleLiteralValue =
  | bigint
  | boolean
  | null
  | number
  | string
  | ModuleLiteralValue[]
  | { [key: string]: ModuleLiteralValue };

interface VerificationModulePaths {
  constructorArgsPath?: string;
  librariesPath?: string;
}

interface VerificationTask {
  args: string[];
  command: string;
  kind: VerificationKind;
  label: string;
}

interface VerificationProviderStatus {
  color: (text: string) => string;
  icon: string;
  text: string;
}

interface ContractVerificationInput {
  address: string;
  constructorArgs?: ModuleLiteralValue;
  contract: string;
  force: boolean;
  kind?: VerificationKind;
  label: string;
  libraries?: ModuleLiteralValue;
  network: string;
  provider: VerificationProvider;
  runDir: string;
  slug: string;
}

/** Print CLI usage and example invocations for the verifier wrapper. */
function printUsage(): void {
  console.error(`Usage:
  npm run verify:initial-stack -- --run-dir <path-to-run-dir> [--provider <etherscan|sourcify>] [--force] [--dry-run]
  npm run verify:initial-stack -- --grvt-env <staging|testnet|production> --network <network> --run-id <run-id> [--provider <etherscan|sourcify>] [--force] [--dry-run]
  npm run verify:initial-stack -- --grvt-env <staging|testnet|production> --network <network> --latest [--provider <etherscan|sourcify>] [--force] [--dry-run]

Examples:
  npm run verify:initial-stack -- --grvt-env testnet --network sepolia --latest
  npm run verify:initial-stack -- --run-dir ignition/deployments/initial-stack/testnet/sepolia/2026-03-15T09-52-59-756Z
`);
}

/** Exit immediately with a formatted fatal error message. */
function fail(message: string): never {
  console.error(chalk.red(`${emoji.get("x")} ${message}`));
  process.exit(1);
}

/** Render a consistent terminal section header used throughout the script. */
function renderSection(title: string, description?: string): void {
  console.log(`\n${SECTION_DIVIDER}`);
  console.log(
    chalk.bold.blue(`${emoji.get("triangular_flag_on_post")} ${title}`),
  );
  if (description !== undefined) {
    console.log(chalk.dim(description));
  }
  console.log(SECTION_DIVIDER);
}

/** Print one labeled metadata line in the run summary output. */
function printKeyValue(label: string, value: string): void {
  console.log(`${chalk.cyan(label)} ${chalk.white(value)}`);
}

/** Describe which verification provider this run will use and why. */
function verificationProviderStatus(): VerificationProviderStatus {
  const provider = resolveVerificationProvider();

  if (provider === "sourcify") {
    return {
      color: chalk.cyan,
      icon: emoji.get("information_source") ?? "",
      text: "Using Sourcify for verification because ETHERSCAN_API_KEY is not loaded.",
    };
  }

  return {
    color: chalk.green,
    icon: emoji.get("white_check_mark") ?? "",
    text: "Using Etherscan for verification.",
  };
}

/** Convert an internal verification kind into a short user-facing label. */
function verificationKindLabel(kind: VerificationKind): string {
  switch (kind) {
    case "contract":
      return "Contract";
    case "proxy-admin":
      return "ProxyAdmin";
    default:
      return "Ignition deployment";
  }
}

/** Render the raw shell command for one planned verification item. */
function commandText(verification: VerificationTask): string {
  return `${verification.command} ${verification.args.join(" ")}`;
}

/** Print the full verification plan with counts and per-target commands. */
function printVerificationPlan(verifications: VerificationTask[]): void {
  const contractCount = verifications.filter(
    (verification) => verification.kind === "contract",
  ).length;
  const proxyAdminCount = verifications.filter(
    (verification) => verification.kind === "proxy-admin",
  ).length;
  const ignitionCount = verifications.length - contractCount - proxyAdminCount;

  console.log(
    chalk.dim(
      `Plan: ${verifications.length} verification target${verifications.length === 1 ? "" : "s"} (${contractCount} Contract, ${proxyAdminCount} ProxyAdmin${ignitionCount > 0 ? `, ${ignitionCount} Ignition` : ""}).`,
    ),
  );

  for (const [index, verification] of verifications.entries()) {
    console.log(
      `${chalk.bold(`${index + 1}.`)} ${chalk.white(verification.label)}`,
    );
    console.log(chalk.dim(`   ${verificationKindLabel(verification.kind)}`));
    console.log(chalk.dim(`   ${commandText(verification)}`));
  }
}

/** Parse supported CLI flags into a normalized options object. */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    force: false,
    grvtEnv: undefined,
    latest: false,
    network: undefined,
    provider: undefined,
    runDir: undefined,
    runId: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--latest") {
      options.latest = true;
      continue;
    }
    if (arg === "--grvt-env") {
      options.grvtEnv = requireOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--network") {
      options.network = requireOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      options.provider = requireOptionValue(
        argv,
        index,
        arg,
      ) as VerificationProvider;
      index += 1;
      continue;
    }
    if (arg === "--run-dir") {
      options.runDir = requireOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--run-id") {
      options.runId = requireOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    fail(`unknown argument: ${arg}`);
  }

  return options;
}

/** Pick a verification provider from CLI input or environment defaults. */
function resolveVerificationProvider(
  explicitProvider?: string,
): VerificationProvider {
  if (explicitProvider !== undefined) {
    if (!["etherscan", "sourcify"].includes(explicitProvider)) {
      fail(`unsupported provider: ${explicitProvider}`);
    }
    return explicitProvider as VerificationProvider;
  }

  return process.env.ETHERSCAN_API_KEY !== undefined ? "etherscan" : "sourcify";
}

/** Require a value after a flag and fail early if the user omitted it. */
function requireOptionValue(
  argv: string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`missing value for ${flag}`);
  }

  return value;
}

/** Resolve the target run directory from either an explicit path or env/network selectors. */
function resolveRunDirectory(options: CliOptions): string {
  if (options.runDir !== undefined) {
    const candidate = resolve(process.cwd(), options.runDir);
    if (!existsSync(candidate)) {
      fail(`run directory does not exist: ${candidate}`);
    }

    if (basename(candidate) === "manifest.json") {
      return dirname(candidate);
    }

    return candidate;
  }

  if (options.grvtEnv === undefined || options.network === undefined) {
    fail("either --run-dir or both --grvt-env and --network are required");
  }

  const selectedByLatest = options.latest;
  const selectedByRunId = options.runId !== undefined;
  if (selectedByLatest === selectedByRunId) {
    fail("choose exactly one of --latest or --run-id");
  }

  const networkRunsDir = join(
    INITIAL_STACK_ARTIFACTS_DIR,
    options.grvtEnv,
    options.network,
  );
  if (!existsSync(networkRunsDir)) {
    fail(`run directory does not exist: ${networkRunsDir}`);
  }

  if (options.runId !== undefined) {
    const runDir = join(networkRunsDir, options.runId);
    if (!existsSync(runDir)) {
      fail(`run directory does not exist: ${runDir}`);
    }
    return runDir;
  }

  const runIds = readdirSync(networkRunsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const latestRunId = runIds.at(-1);
  if (latestRunId === undefined) {
    fail(`no runs found under: ${networkRunsDir}`);
  }

  return join(networkRunsDir, latestRunId);
}

/** Load and parse the saved manifest for one initial-stack deployment run. */
function readManifest(runDir: string): Manifest {
  const manifestPath = join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`manifest not found: ${manifestPath}`);
  }

  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

/** Extract an Ignition deployment id from the command text persisted in the manifest. */
function extractDeploymentId(command: unknown): string | undefined {
  if (typeof command !== "string") {
    return undefined;
  }

  const match = command.match(/(?:^|\s)--deployment-id\s+([^\s]+)/);
  return match?.[1];
}

/** Convert an absolute path into a repo-relative path for Hardhat CLI flags. */
function repoRelativePath(filePath: string): string {
  return relative(REPO_ROOT, filePath) || ".";
}

/** Parse bigint-like manifest values that may be stored as strings with a trailing `n`. */
function parseBigIntText(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string" && value.endsWith("n")) {
    return BigInt(value.slice(0, -1));
  }
  return BigInt(value as string | number | bigint | boolean);
}

/** Serialize JS values into a simple ESM literal for temporary module exports. */
function toModuleLiteral(value: unknown): string {
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => toModuleLiteral(item)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{\n${Object.entries(value)
      .map(
        ([key, entryValue]) =>
          `  ${JSON.stringify(key)}: ${toModuleLiteral(entryValue)},`,
      )
      .join("\n")}\n}`;
  }
  return JSON.stringify(value);
}

/** Write a `default export` ESM module consumed by Hardhat verify path flags. */
function writeDefaultExportModule(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `export default ${toModuleLiteral(value)};\n`);
}

/** Materialize constructor-args and library helper modules for one verification target. */
function createVerificationModules(
  runDir: string,
  slug: string,
  constructorArgs?: ModuleLiteralValue,
  libraries?: ModuleLiteralValue,
): VerificationModulePaths {
  const verifyInputsDir = join(runDir, VERIFY_INPUTS_DIRNAME);
  mkdirSync(verifyInputsDir, { recursive: true });

  const modulePaths: VerificationModulePaths = {};
  if (constructorArgs !== undefined) {
    const constructorArgsPath = join(
      verifyInputsDir,
      `${slug}.constructor-args.mjs`,
    );
    writeDefaultExportModule(constructorArgsPath, constructorArgs);
    modulePaths.constructorArgsPath = constructorArgsPath;
  }
  if (libraries !== undefined) {
    const librariesPath = join(verifyInputsDir, `${slug}.libraries.mjs`);
    writeDefaultExportModule(librariesPath, libraries);
    modulePaths.librariesPath = librariesPath;
  }

  return modulePaths;
}

/** Build one explicit `hardhat verify <provider>` invocation plus its helper modules. */
function buildContractVerification({
  address,
  constructorArgs,
  contract,
  force,
  kind = "contract",
  label,
  libraries,
  network,
  provider,
  runDir,
  slug,
}: ContractVerificationInput): VerificationTask {
  const modulePaths = createVerificationModules(
    runDir,
    slug,
    constructorArgs,
    libraries,
  );
  const args = [
    "hardhat",
    "verify",
    provider,
    "--network",
    network,
    "--contract",
    contract,
  ];

  if (modulePaths.constructorArgsPath !== undefined) {
    args.push(
      "--constructor-args-path",
      repoRelativePath(modulePaths.constructorArgsPath),
    );
  }
  if (modulePaths.librariesPath !== undefined) {
    args.push("--libraries-path", repoRelativePath(modulePaths.librariesPath));
  }
  if (force) {
    args.push("--force");
  }
  args.push(address);

  return {
    command: "npx",
    args,
    kind,
    label: `${label} (${address})`,
  };
}

/** Find a named deployment step in the persisted run manifest. */
function getStep(
  manifest: Manifest,
  stepName: string,
): ManifestStep | undefined {
  return manifest.steps.find((step) => step.name === stepName);
}

/** Load Ignition's persisted address map for a completed deployment step. */
function getDeploymentAddresses(
  step: ManifestStep | undefined,
): Record<string, string> | undefined {
  const deploymentId = extractDeploymentId(step?.command);
  if (deploymentId === undefined) {
    return undefined;
  }

  const deployedAddressesPath = join(
    REPO_ROOT,
    "ignition",
    "deployments",
    deploymentId,
    "deployed_addresses.json",
  );
  if (!existsSync(deployedAddressesPath)) {
    return undefined;
  }

  return JSON.parse(readFileSync(deployedAddressesPath, "utf8")) as Record<
    string,
    string
  >;
}

/**
 * Build the explicit verification plan for one saved run.
 *
 * This is the core of the script: it reconstructs each deployed contract's
 * verification inputs from the manifest and Ignition address outputs instead of
 * trusting `ignition verify` to infer packaged OZ artifact details correctly.
 */
function buildManualVerifications(
  manifest: Manifest,
  force: boolean,
  runDir: string,
  provider: VerificationProvider,
): VerificationTask[] {
  const verifications: VerificationTask[] = [];
  const network = manifest.network.alias;

  const mockPrereqStep = getStep(manifest, "Mock Aave prerequisite deployment");
  const mockPrereqDeployed = getDeploymentAddresses(mockPrereqStep);
  if (mockPrereqDeployed !== undefined) {
    const underlyingToken =
      manifest.resolvedParams.strategyCore.underlyingToken;
    const aavePool =
      mockPrereqDeployed["MockAavePrerequisitesModule#MockAavePool"];
    const aToken =
      mockPrereqDeployed["MockAavePrerequisitesModule#MockAaveAToken"];

    verifications.push(
      buildContractVerification({
        address: aavePool,
        constructorArgs: [underlyingToken],
        contract: MOCK_AAVE_POOL_CONTRACT,
        force,
        label: "Mock Aave pool",
        network,
        provider,
        runDir,
        slug: "mock-aave-pool",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: aToken,
        constructorArgs: [
          underlyingToken,
          aavePool,
          manifest.resolvedParams.aTokenName,
          manifest.resolvedParams.aTokenSymbol,
        ],
        contract: MOCK_AAVE_ATOKEN_CONTRACT,
        force,
        label: "Mock Aave aToken",
        network,
        provider,
        runDir,
        slug: "mock-aave-atoken",
      }),
    );
  }

  const vaultCoreStep = getStep(manifest, "Vault core deployment");
  const vaultCoreDeployed = getDeploymentAddresses(vaultCoreStep);
  if (vaultCoreDeployed !== undefined) {
    const vaultStrategyOpsLib =
      vaultCoreDeployed["VaultCoreModule#VaultStrategyOpsLib"];
    const vaultBridgeLib = vaultCoreDeployed["VaultCoreModule#VaultBridgeLib"];
    const vaultImplementation =
      vaultCoreDeployed["VaultCoreModule#VaultImplementation"];
    const vaultProxy = vaultCoreDeployed["VaultCoreModule#VaultProxy"];
    const vaultInitializeCalldata = encodeFunctionData({
      abi: VAULT_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        manifest.resolvedParams.vaultCore.deployAdmin,
        manifest.resolvedParams.vaultCore.bridgeHub,
        manifest.resolvedParams.vaultCore.grvtBridgeProxyFeeToken,
        parseBigIntText(manifest.resolvedParams.vaultCore.l2ChainId),
        manifest.resolvedParams.vaultCore.l2ExchangeRecipient,
        manifest.resolvedParams.vaultCore.wrappedNativeToken,
        manifest.resolvedParams.vaultCore.yieldRecipient,
      ],
    });

    verifications.push(
      buildContractVerification({
        address: vaultStrategyOpsLib,
        contract: VAULT_STRATEGY_OPS_LIB_CONTRACT,
        force,
        label: "VaultStrategyOpsLib",
        network,
        provider,
        runDir,
        slug: "vault-strategy-ops-lib",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: vaultBridgeLib,
        contract: VAULT_BRIDGE_LIB_CONTRACT,
        force,
        label: "VaultBridgeLib",
        network,
        provider,
        runDir,
        slug: "vault-bridge-lib",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: vaultImplementation,
        contract: VAULT_IMPLEMENTATION_CONTRACT,
        force,
        label: "Vault implementation",
        libraries: {
          [VAULT_STRATEGY_OPS_LIB_CONTRACT]: vaultStrategyOpsLib,
          [VAULT_BRIDGE_LIB_CONTRACT]: vaultBridgeLib,
        },
        network,
        provider,
        runDir,
        slug: "vault-implementation",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: vaultProxy,
        constructorArgs: [
          vaultImplementation,
          manifest.resolvedParams.vaultCore.deployAdmin,
          vaultInitializeCalldata,
        ],
        contract: TRANSPARENT_PROXY_CONTRACT,
        force,
        label: "Vault proxy",
        network,
        provider,
        runDir,
        slug: "vault-proxy",
      }),
    );
    if (typeof vaultCoreStep?.addresses?.vaultProxyAdmin === "string") {
      verifications.push(
        buildContractVerification({
          address: vaultCoreStep.addresses.vaultProxyAdmin,
          constructorArgs: [manifest.resolvedParams.vaultCore.deployAdmin],
          contract: PROXY_ADMIN_CONTRACT,
          force,
          kind: "proxy-admin",
          label: "Vault ProxyAdmin",
          network,
          provider,
          runDir,
          slug: "vault-proxy-admin",
        }),
      );
    }
  }

  const strategyCoreStep = getStep(manifest, "Strategy core deployment");
  const strategyCoreDeployed = getDeploymentAddresses(strategyCoreStep);
  if (strategyCoreDeployed !== undefined) {
    const strategyImplementation =
      strategyCoreDeployed["StrategyCoreModule#StrategyImplementation"];
    const strategyProxy =
      strategyCoreDeployed["StrategyCoreModule#StrategyProxy"];
    const strategyInitializeCalldata = encodeFunctionData({
      abi: STRATEGY_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        manifest.resolvedParams.strategyCore.vaultProxy,
        manifest.resolvedParams.strategyCore.aavePool,
        manifest.resolvedParams.strategyCore.underlyingToken,
        manifest.resolvedParams.strategyCore.aToken,
        manifest.resolvedParams.strategyCore.strategyName,
      ],
    });

    verifications.push(
      buildContractVerification({
        address: strategyImplementation,
        contract: STRATEGY_IMPLEMENTATION_CONTRACT,
        force,
        label: "Strategy implementation",
        network,
        provider,
        runDir,
        slug: "strategy-implementation",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: strategyProxy,
        constructorArgs: [
          strategyImplementation,
          manifest.resolvedParams.strategyCore.proxyAdminOwner,
          strategyInitializeCalldata,
        ],
        contract: TRANSPARENT_PROXY_CONTRACT,
        force,
        label: "Strategy proxy",
        network,
        provider,
        runDir,
        slug: "strategy-proxy",
      }),
    );
    if (typeof strategyCoreStep?.addresses?.strategyProxyAdmin === "string") {
      verifications.push(
        buildContractVerification({
          address: strategyCoreStep.addresses.strategyProxyAdmin,
          constructorArgs: [
            manifest.resolvedParams.strategyCore.proxyAdminOwner,
          ],
          contract: PROXY_ADMIN_CONTRACT,
          force,
          kind: "proxy-admin",
          label: "Strategy ProxyAdmin",
          network,
          provider,
          runDir,
          slug: "strategy-proxy-admin",
        }),
      );
    }
  }

  const timelockDeployed = getDeploymentAddresses(
    getStep(manifest, "Yield recipient timelock bootstrap"),
  );
  if (timelockDeployed !== undefined) {
    const timelockAddress =
      timelockDeployed["VaultYieldRecipientTimelockModule#TimelockController"];
    verifications.push(
      buildContractVerification({
        address: timelockAddress,
        constructorArgs: [
          parseBigIntText(
            manifest.resolvedParams.yieldRecipientBootstrap.minDelay,
          ),
          manifest.resolvedParams.yieldRecipientBootstrap.proposers,
          manifest.resolvedParams.yieldRecipientBootstrap.executors,
          manifest.resolvedParams.yieldRecipientBootstrap.admin,
        ],
        contract: TIMELOCK_CONTROLLER_CONTRACT,
        force,
        label: "Yield recipient timelock controller",
        network,
        provider,
        runDir,
        slug: "yield-recipient-timelock-controller",
      }),
    );
  }

  const nativeGatewaysStep = getStep(manifest, "Native gateways deployment");
  const nativeGatewaysDeployed = getDeploymentAddresses(nativeGatewaysStep);
  if (nativeGatewaysDeployed !== undefined) {
    const nativeVaultGateway =
      nativeGatewaysDeployed["NativeGatewaysModule#NativeVaultGateway"];
    const nativeBridgeGatewayImplementation =
      nativeGatewaysDeployed[
        "NativeGatewaysModule#NativeBridgeGatewayImplementation"
      ];
    const nativeBridgeGatewayProxy =
      nativeGatewaysDeployed["NativeGatewaysModule#NativeBridgeGatewayProxy"];
    const nativeBridgeGatewayInitializeCalldata = encodeFunctionData({
      abi: NATIVE_BRIDGE_GATEWAY_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        manifest.resolvedParams.nativeGateways.wrappedNativeToken,
        manifest.resolvedParams.nativeGateways.grvtBridgeProxyFeeToken,
        manifest.resolvedParams.nativeGateways.bridgeHub,
        manifest.resolvedParams.nativeGateways.vaultProxy,
      ],
    });

    verifications.push(
      buildContractVerification({
        address: nativeVaultGateway,
        constructorArgs: [
          manifest.resolvedParams.nativeGateways.wrappedNativeToken,
          manifest.resolvedParams.nativeGateways.vaultProxy,
        ],
        contract: NATIVE_VAULT_GATEWAY_CONTRACT,
        force,
        label: "NativeVaultGateway",
        network,
        provider,
        runDir,
        slug: "native-vault-gateway",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: nativeBridgeGatewayImplementation,
        contract: NATIVE_BRIDGE_GATEWAY_CONTRACT,
        force,
        label: "NativeBridgeGateway implementation",
        network,
        provider,
        runDir,
        slug: "native-bridge-gateway-implementation",
      }),
    );
    verifications.push(
      buildContractVerification({
        address: nativeBridgeGatewayProxy,
        constructorArgs: [
          nativeBridgeGatewayImplementation,
          manifest.resolvedParams.nativeGateways.proxyAdminOwner,
          nativeBridgeGatewayInitializeCalldata,
        ],
        contract: TRANSPARENT_PROXY_CONTRACT,
        force,
        label: "NativeBridgeGateway proxy",
        network,
        provider,
        runDir,
        slug: "native-bridge-gateway-proxy",
      }),
    );
    if (
      typeof nativeGatewaysStep?.addresses?.nativeBridgeGatewayProxyAdmin ===
      "string"
    ) {
      verifications.push(
        buildContractVerification({
          address: nativeGatewaysStep.addresses.nativeBridgeGatewayProxyAdmin,
          constructorArgs: [
            manifest.resolvedParams.nativeGateways.proxyAdminOwner,
          ],
          contract: PROXY_ADMIN_CONTRACT,
          force,
          kind: "proxy-admin",
          label: "NativeBridgeGateway ProxyAdmin",
          network,
          provider,
          runDir,
          slug: "native-bridge-gateway-proxy-admin",
        }),
      );
    }
  }

  return verifications;
}

/** Spawn one verification subprocess and inherit its stdout/stderr directly. */
function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      resolvePromise(code ?? 1);
    });
    child.on("error", () => {
      resolvePromise(1);
    });
  });
}

/** Orchestrate the full verification flow from argument parsing to final exit status. */
async function main(): Promise<void> {
  const setupSpinner = ora({
    text: "Loading verification run metadata...",
  }).start();
  const options = parseArgs(process.argv.slice(2));
  const runDir = resolveRunDirectory(options);
  const manifest = readManifest(runDir);
  const provider = resolveVerificationProvider(options.provider);

  const verifications = buildManualVerifications(
    manifest,
    options.force,
    runDir,
    provider,
  );

  if (verifications.length === 0) {
    fail("no verifiable deployments were found in the selected run");
  }

  setupSpinner.succeed("Verification run loaded.");

  renderSection(
    "Verification Run",
    "Review the saved deployment run and planned verification targets before explorer requests are sent.",
  );
  printKeyValue("Run directory:", runDir);
  printKeyValue(
    "Network:",
    `${manifest.network.alias} (${manifest.network.chainId})`,
  );
  printKeyValue("Environment:", manifest.environment.grvtEnv);
  printKeyValue("Run ID:", manifest.runId);
  if (options.force) {
    printKeyValue("Mode:", "force re-verify");
  }
  printKeyValue("Provider:", provider);

  const providerStatus = verificationProviderStatus();
  console.log("");
  console.log(
    providerStatus.color(`${providerStatus.icon} ${providerStatus.text}`),
  );

  renderSection("Verification Plan");
  printVerificationPlan(verifications);

  if (options.dryRun) {
    console.log("");
    console.log(
      chalk.green(
        `${emoji.get("white_check_mark")} Dry run complete. No verification commands were executed.`,
      ),
    );
    return;
  }

  const failures: string[] = [];

  for (const [index, verification] of verifications.entries()) {
    const progress = `${index + 1}/${verifications.length}`;
    console.log("");
    renderSection(
      `Running ${verificationKindLabel(verification.kind)} (${progress})`,
      verification.label,
    );
    console.log(chalk.dim(commandText(verification)));
    const exitCode = await runCommand(verification.command, verification.args);
    if (exitCode !== 0) {
      failures.push(verification.label);
      console.log(
        chalk.red(
          `${emoji.get("x")} Verification failed: ${verification.label}`,
        ),
      );
      continue;
    }
    console.log(
      chalk.green(
        `${emoji.get("white_check_mark")} Verification succeeded: ${verification.label}`,
      ),
    );
  }

  console.log("");
  if (failures.length === 0) {
    console.log(
      chalk.green(
        `${emoji.get("confetti_ball")} Verification completed successfully.`,
      ),
    );
    return;
  }

  console.error(
    chalk.red(`${emoji.get("warning")} Verification completed with failures.`),
  );
  for (const failure of failures) {
    console.error(chalk.red(`- ${failure}`));
  }
  process.exit(1);
}

await main();
