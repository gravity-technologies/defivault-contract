#!/usr/bin/env node

import "dotenv/config";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import * as emoji from "node-emoji";
import ora from "ora";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadCompiledVaultAbi } from "../report/treasury-vault-state-lib.js";

/**
 * Single-environment operator CLI for exercising the vault strategy allocation
 * path on Ethereum Sepolia: preflight, allocate, partial deallocate, and
 * optional full unwind against a resolved staging or testnet deployment.
 *
 * Example:
 * `npm run ops:strategy-allocation-smoke -- --env staging --amount 10 --partial-amount 4`
 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_NETWORK = "sepolia";
const DEFAULT_STRATEGY_KEY = "primary";
const DEFAULT_AMOUNT = "10";
const ENVIRONMENTS = ["staging", "testnet"] as const;
const SECTION_DIVIDER = chalk.blue("=".repeat(72));

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const strategyAbi = parseAbi([
  "function strategyExposure(address token) view returns (uint256)",
]);

type Environment = (typeof ENVIRONMENTS)[number];

interface CliOptions {
  amount: string;
  dryRun: boolean;
  env?: Environment;
  fullUnwind: boolean;
  network: string;
  partialAmount?: string;
  strategyKey: string;
}

interface DeploymentSnapshot {
  environment: string;
  network: {
    chainId: number;
    name: string;
  };
  strategies: Record<string, DeploymentStrategy>;
  vault?: {
    proxy: Address;
  };
}

interface DeploymentStrategy {
  aToken: Address;
  aavePool: Address;
  key: string;
  proxy: Address;
  vaultToken: Address;
}

interface InitialStackManifest {
  resolvedParams: {
    strategyCore: {
      aToken: Address;
      aavePool: Address;
    };
    vaultTokenStrategy: {
      strategyProxy: Address;
      vaultProxy: Address;
      vaultToken: Address;
    };
  };
}

interface ResolvedDeployment {
  aToken: Address;
  aavePool: Address;
  environment: Environment;
  network: string;
  source: string;
  strategy: Address;
  strategyKey: string;
  token: Address;
  vault: Address;
}

interface Snapshot {
  aTokenBalance: bigint;
  costBasis: bigint;
  strategyExposure: bigint;
  vaultBalance: bigint;
}

/** Render one styled section heading for terminal output. */
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

/** Print one labeled line of operator-facing metadata. */
function printKeyValue(label: string, value: string): void {
  console.log(`${chalk.cyan(label)} ${chalk.white(value)}`);
}

/** Print one formatted accounting snapshot for before/after comparisons. */
function printSnapshot(
  label: string,
  snapshot: Snapshot,
  decimals: number,
  symbol: string,
): void {
  console.log(chalk.bold(label));
  printKeyValue(
    "  Vault balance:",
    `${formatUnits(snapshot.vaultBalance, decimals)} ${symbol}`,
  );
  printKeyValue(
    "  Strategy exposure:",
    `${formatUnits(snapshot.strategyExposure, decimals)} ${symbol}`,
  );
  printKeyValue(
    "  Cost basis:",
    `${formatUnits(snapshot.costBasis, decimals)} ${symbol}`,
  );
  printKeyValue(
    "  aToken balance:",
    `${formatUnits(snapshot.aTokenBalance, decimals)} ${symbol}`,
  );
}

/** Parse CLI flags into normalized smoke-test options. */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    amount: DEFAULT_AMOUNT,
    dryRun: false,
    fullUnwind: true,
    network: DEFAULT_NETWORK,
    strategyKey: DEFAULT_STRATEGY_KEY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-full-unwind") {
      options.fullUnwind = false;
      continue;
    }
    if (arg === "--env") {
      options.env = parseEnvironment(argv[++index]);
      continue;
    }
    if (arg === "--network") {
      options.network = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--strategy-key") {
      options.strategyKey = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--amount") {
      options.amount = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--partial-amount") {
      options.partialAmount = requireValue(arg, argv[++index]);
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

/** Parse one explicit environment value from `--env`. */
function parseEnvironment(value: string | undefined): Environment {
  const normalized = requireValue("--env", value).toLowerCase();
  if (normalized === "staging" || normalized === "testnet") return normalized;
  throw new Error(`unsupported environment: ${normalized}`);
}

/** Resolve environment from CLI first, then `GRVT_ENV`, then default staging. */
function resolveEnvironment(explicitEnv: Environment | undefined): Environment {
  if (explicitEnv !== undefined) return explicitEnv;

  const envValue = process.env.GRVT_ENV;
  if (envValue !== undefined && envValue.trim().length > 0) {
    const normalized = envValue.trim().toLowerCase();
    if (normalized === "staging" || normalized === "testnet") {
      return normalized;
    }
    throw new Error(
      `unsupported GRVT_ENV for strategy allocation smoke: ${envValue}`,
    );
  }

  return "staging";
}

/** Require that one CLI flag is followed by a value. */
function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

/** Build the checked-in registry path for one environment/network pair. */
function deploymentRegistryPath(
  environment: Environment,
  network: string,
): string {
  return join(REPO_ROOT, "deployments", environment, `${network}.json`);
}

/** Build the initial-stack artifact root for one environment/network pair. */
function initialStackRoot(environment: Environment, network: string): string {
  return join(
    REPO_ROOT,
    "ignition",
    "deployments",
    "initial-stack",
    environment,
    network,
  );
}

/** Resolve deployment addresses from the registry or latest saved manifest. */
function resolveDeployment(args: {
  environment: Environment;
  network: string;
  strategyKey: string;
}): ResolvedDeployment {
  const registryPath = deploymentRegistryPath(args.environment, args.network);
  if (existsSync(registryPath)) {
    const snapshot = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as DeploymentSnapshot;
    const strategy = snapshot.strategies[args.strategyKey];
    if (snapshot.vault === undefined) {
      throw new Error(`registry missing vault entry: ${registryPath}`);
    }
    if (strategy === undefined) {
      const availableKeys = Object.keys(snapshot.strategies);
      throw new Error(
        `strategy key ${args.strategyKey} not found in ${registryPath}; available keys: ${availableKeys.join(", ") || "(none)"}`,
      );
    }

    return {
      aToken: strategy.aToken,
      aavePool: strategy.aavePool,
      environment: args.environment,
      network: args.network,
      source: relativeToRepo(registryPath),
      strategy: strategy.proxy,
      strategyKey: strategy.key,
      token: strategy.vaultToken,
      vault: snapshot.vault.proxy,
    };
  }

  const manifestPath = latestInitialStackManifestPath(
    args.environment,
    args.network,
  );
  if (manifestPath === undefined) {
    throw new Error(
      `no deployment registry or initial-stack manifest found for ${args.environment}/${args.network}`,
    );
  }

  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as InitialStackManifest;

  return {
    aToken: manifest.resolvedParams.strategyCore.aToken,
    aavePool: manifest.resolvedParams.strategyCore.aavePool,
    environment: args.environment,
    network: args.network,
    source: relativeToRepo(manifestPath),
    strategy: manifest.resolvedParams.vaultTokenStrategy.strategyProxy,
    strategyKey: args.strategyKey,
    token: manifest.resolvedParams.vaultTokenStrategy.vaultToken,
    vault: manifest.resolvedParams.vaultTokenStrategy.vaultProxy,
  };
}

/** Find the latest initial-stack manifest for one environment/network pair. */
function latestInitialStackManifestPath(
  environment: Environment,
  network: string,
): string | undefined {
  const root = initialStackRoot(environment, network);
  if (!existsSync(root)) return undefined;

  const runDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const latestRunDir = runDirs.at(-1);
  if (latestRunDir === undefined) return undefined;

  return join(root, latestRunDir, "manifest.json");
}

/** Convert an absolute path to a repo-relative label for display. */
function relativeToRepo(filePath: string): string {
  return filePath.replace(`${REPO_ROOT}/`, "");
}

/** Normalize a private key into the `0x`-prefixed form viem expects. */
function parsePrivateKey(rawPrivateKey: string | undefined): Hex {
  if (rawPrivateKey === undefined || rawPrivateKey.length === 0) {
    throw new Error("OPERATOR_PRIVATE_KEY is not set");
  }
  return rawPrivateKey.startsWith("0x")
    ? (rawPrivateKey as Hex)
    : (`0x${rawPrivateKey}` as Hex);
}

/** Read the vault/strategy balances and accounting state in one batch. */
async function readSnapshot(args: {
  aToken: Address;
  publicClient: ReturnType<typeof createPublicClient>;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
}): Promise<Snapshot> {
  const [vaultBalance, aTokenBalance, strategyExposure, rawCostBasis] =
    await Promise.all([
      args.publicClient.readContract({
        address: args.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [args.vault],
      }),
      args.publicClient.readContract({
        address: args.aToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [args.strategy],
      }),
      args.publicClient.readContract({
        address: args.strategy,
        abi: strategyAbi,
        functionName: "strategyExposure",
        args: [args.token],
      }),
      args.publicClient.readContract({
        address: args.vault,
        abi: args.vaultAbi,
        functionName: "strategyCostBasis",
        args: [args.token, args.strategy],
      }),
    ]);
  const costBasis = rawCostBasis as bigint;

  return { aTokenBalance, costBasis, strategyExposure, vaultBalance };
}

/** Simulate, send, and confirm one allocate transaction. */
async function writeAllocateAndWait(args: {
  account: ReturnType<typeof privateKeyToAccount>;
  amount: bigint;
  publicClient: ReturnType<typeof createPublicClient>;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
  walletClient: ReturnType<typeof createWalletClient>;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.vault,
    abi: args.vaultAbi,
    functionName: "allocateVaultTokenToStrategy",
    args: [args.token, args.strategy, args.amount],
  });

  const hash = await args.walletClient.writeContract(request);
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Simulate, send, and confirm one partial deallocation transaction. */
async function writePartialDeallocateAndWait(args: {
  account: ReturnType<typeof privateKeyToAccount>;
  amount: bigint;
  publicClient: ReturnType<typeof createPublicClient>;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
  walletClient: ReturnType<typeof createWalletClient>;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.vault,
    abi: args.vaultAbi,
    functionName: "deallocateVaultTokenFromStrategy",
    args: [args.token, args.strategy, args.amount],
  });

  const hash = await args.walletClient.writeContract(request);
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Simulate, send, and confirm one full-unwind transaction. */
async function writeDeallocateAllAndWait(args: {
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: ReturnType<typeof createPublicClient>;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
  walletClient: ReturnType<typeof createWalletClient>;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.vault,
    abi: args.vaultAbi,
    functionName: "deallocateAllVaultTokenFromStrategy",
    args: [args.token, args.strategy],
  });

  const hash = await args.walletClient.writeContract(request);
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Run the full smoke flow against one resolved deployment environment. */
async function runEnvironment(args: {
  account: ReturnType<typeof privateKeyToAccount>;
  deployment: ResolvedDeployment;
  dryRun: boolean;
  fullUnwind: boolean;
  mintAmount: bigint;
  partialAmount: bigint;
  publicClient: ReturnType<typeof createPublicClient>;
  vaultAbi: Abi;
  walletClient: ReturnType<typeof createWalletClient>;
}): Promise<void> {
  const {
    account,
    deployment,
    dryRun,
    fullUnwind,
    mintAmount,
    partialAmount,
    publicClient,
    vaultAbi,
    walletClient,
  } = args;

  const [decimals, symbol, allocatorRole, paused, supported, whitelisted] =
    await Promise.all([
      publicClient.readContract({
        address: deployment.token,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: deployment.token,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: deployment.vault,
        abi: vaultAbi,
        functionName: "ALLOCATOR_ROLE",
      }),
      publicClient.readContract({
        address: deployment.vault,
        abi: vaultAbi,
        functionName: "paused",
      }),
      publicClient.readContract({
        address: deployment.vault,
        abi: vaultAbi,
        functionName: "isSupportedVaultToken",
        args: [deployment.token],
      }),
      publicClient.readContract({
        address: deployment.vault,
        abi: vaultAbi,
        functionName: "isStrategyWhitelistedForVaultToken",
        args: [deployment.token, deployment.strategy],
      }),
    ]);

  const hasAllocatorRole = await publicClient.readContract({
    address: deployment.vault,
    abi: vaultAbi,
    functionName: "hasRole",
    args: [allocatorRole, account.address],
  });

  renderSection(
    "Strategy Allocation Smoke",
    `Environment ${deployment.environment} on ${deployment.network}`,
  );
  printKeyValue("Source:", deployment.source);
  printKeyValue("Vault:", deployment.vault);
  printKeyValue(
    "Token:",
    `${deployment.token} (${symbol}, ${decimals} decimals)`,
  );
  printKeyValue(
    "Strategy:",
    `${deployment.strategy} [${deployment.strategyKey}]`,
  );
  printKeyValue("aToken:", deployment.aToken);
  printKeyValue("Aave pool:", deployment.aavePool);
  printKeyValue("Operator:", account.address);

  if (paused) {
    throw new Error(`${deployment.environment}: vault is paused`);
  }
  if (!supported) {
    throw new Error(`${deployment.environment}: vault token is not supported`);
  }
  if (!whitelisted) {
    throw new Error(`${deployment.environment}: strategy is not whitelisted`);
  }
  if (!hasAllocatorRole) {
    throw new Error(
      `${deployment.environment}: signer ${account.address} does not have ALLOCATOR_ROLE`,
    );
  }

  console.log(
    chalk.green(`${emoji.get("white_check_mark")} preflight checks passed`),
  );

  const initial = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
  });
  printSnapshot("before", initial, decimals, symbol);

  if (initial.vaultBalance < mintAmount) {
    throw new Error(
      `${deployment.environment}: vault idle balance ${formatUnits(initial.vaultBalance, decimals)} ${symbol} is below requested allocation ${formatUnits(mintAmount, decimals)} ${symbol}`,
    );
  }

  printKeyValue(
    "Requested allocation:",
    `${formatUnits(mintAmount, decimals)} ${symbol}`,
  );
  printKeyValue(
    "Partial deallocation:",
    `${formatUnits(partialAmount, decimals)} ${symbol}`,
  );

  if (dryRun) {
    console.log(
      chalk.yellow(
        `${emoji.get("warning")} dry-run only, no transactions sent`,
      ),
    );
    return;
  }

  const allocateSpinner = ora("Allocating vault funds to strategy").start();
  const allocateHash = await writeAllocateAndWait({
    account,
    amount: mintAmount,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
    walletClient,
  });
  allocateSpinner.succeed(`Allocated funds to strategy (${allocateHash})`);

  const afterAllocate = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
  });
  printSnapshot("after allocate", afterAllocate, decimals, symbol);

  const partialSpinner = ora(
    "Deallocating partial position from strategy",
  ).start();
  const partialHash = await writePartialDeallocateAndWait({
    account,
    amount: partialAmount,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
    walletClient,
  });
  partialSpinner.succeed(
    `Partially deallocated strategy position (${partialHash})`,
  );

  const afterPartial = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
  });
  printSnapshot("after partial deallocate", afterPartial, decimals, symbol);

  if (!fullUnwind) {
    console.log(
      chalk.yellow(
        `${emoji.get("information_source")} stopping after partial deallocation`,
      ),
    );
    return;
  }

  const unwindSpinner = ora(
    "Fully unwinding remaining strategy position",
  ).start();
  const unwindHash = await writeDeallocateAllAndWait({
    account,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
    walletClient,
  });
  unwindSpinner.succeed(`Fully unwound strategy position (${unwindHash})`);

  const afterUnwind = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vaultAbi,
    vault: deployment.vault,
  });
  printSnapshot("after full unwind", afterUnwind, decimals, symbol);
  console.log(
    chalk.green(
      `${emoji.get("tada")} strategy allocation smoke completed successfully`,
    ),
  );
}

/** Resolve inputs, connect clients, and execute the smoke flow once. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const environment = resolveEnvironment(options.env);
  const rpcUrl = process.env.ETHEREUM_SEPOLIA_RPC_URL;
  if (rpcUrl === undefined || rpcUrl.length === 0) {
    throw new Error("ETHEREUM_SEPOLIA_RPC_URL is not set");
  }

  const account = privateKeyToAccount(
    parsePrivateKey(process.env.OPERATOR_PRIVATE_KEY),
  );
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const vaultAbi = loadCompiledVaultAbi(REPO_ROOT);

  renderSection("Setup", "Resolving operator, network, and deployment inputs");
  printKeyValue("Network:", options.network);
  printKeyValue("Environment:", environment);
  printKeyValue("Strategy key:", options.strategyKey);
  printKeyValue("Operator:", account.address);

  const resolveSpinner = ora("Resolving deployment metadata").start();
  const deployment = resolveDeployment({
    environment,
    network: options.network,
    strategyKey: options.strategyKey,
  });
  resolveSpinner.succeed(
    `Resolved deployment metadata from ${deployment.source}`,
  );
  const decimals = await publicClient.readContract({
    address: deployment.token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const mintAmount = parseUnits(options.amount, decimals);
  const partialAmount =
    options.partialAmount === undefined
      ? mintAmount / 2n
      : parseUnits(options.partialAmount, decimals);

  if (mintAmount <= 0n) {
    throw new Error("amount must be greater than 0");
  }
  if (partialAmount <= 0n) {
    throw new Error("partial amount must be greater than 0");
  }
  if (partialAmount > mintAmount) {
    throw new Error("partial amount must be less than or equal to amount");
  }

  await runEnvironment({
    account,
    deployment,
    dryRun: options.dryRun,
    fullUnwind: options.fullUnwind,
    mintAmount,
    partialAmount,
    publicClient,
    vaultAbi,
    walletClient,
  });
}

/** Print one concise fatal error and exit non-zero. */
void main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "unknown strategy allocation smoke failure";
  console.error(
    `\n${chalk.red(`${emoji.get("x")} strategy allocation smoke failed: ${message}`)}`,
  );
  process.exit(1);
});
