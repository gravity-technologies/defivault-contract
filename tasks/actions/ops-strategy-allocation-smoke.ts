import chalk from "chalk";
import * as emoji from "node-emoji";
import ora from "ora";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import {
  formatUnits,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { loadCompiledVaultAbi } from "../../scripts/report/treasury-vault-state-lib.js";
import { resolveCurrentDeploymentState } from "../../scripts/deploy/operation-records.js";
import { getClients } from "../utils/one-off-ops.js";

const DEFAULT_STRATEGY_KEY = "primary";
const DEFAULT_AMOUNT = "10";
const ENVIRONMENTS = ["staging", "testnet"] as const;
const SECTION_DIVIDER = chalk.blue("=".repeat(72));
const repoRoot = process.cwd();

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const strategyAbi = parseAbi([
  "function strategyExposure(address token) view returns (uint256)",
]);

type Environment = (typeof ENVIRONMENTS)[number];

type StrategyAllocationSmokeTaskArgs = {
  amount: string;
  dryRun: boolean;
  env: string;
  fullUnwind: boolean;
  partialAmount?: string;
  record?: string;
  strategyKey: string;
};

type ResolvedDeployment = {
  aToken: Address;
  aavePool: Address;
  environment: Environment;
  network: string;
  source: string;
  strategy: Address;
  strategyKey: string;
  token: Address;
  vault: Address;
};

type Snapshot = {
  aTokenBalance: bigint;
  costBasis: bigint;
  strategyExposure: bigint;
  vaultBalance: bigint;
};

type Clients = Awaited<ReturnType<typeof getClients>>;
type PublicClientLike = Clients["publicClient"];
type WalletClientLike = Clients["walletClient"];
type WalletAccountLike = NonNullable<WalletClientLike["account"]>;

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

function printKeyValue(label: string, value: string): void {
  console.log(`${chalk.cyan(label)} ${chalk.white(value)}`);
}

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

function parseEnvironment(value: string): Environment {
  const normalized = value.toLowerCase();
  if (normalized === "staging" || normalized === "testnet") {
    return normalized;
  }
  throw new Error(`unsupported environment: ${normalized}`);
}

function resolveDeployment(args: {
  environment: Environment;
  network: string;
  recordPathOrDir?: string;
  strategyKey: string;
}): ResolvedDeployment {
  const state = resolveCurrentDeploymentState({
    environment: args.environment,
    network: args.network,
    recordPathOrDir: args.recordPathOrDir,
    repoRoot,
  });
  const strategy = state.strategies[args.strategyKey];
  if (state.vault === undefined) {
    throw new Error(
      `current deployment state is missing vault data for ${args.environment}/${args.network}`,
    );
  }
  if (strategy === undefined) {
    const availableKeys = Object.keys(state.strategies);
    throw new Error(
      `strategy key ${args.strategyKey} not found in current deployment state; available keys: ${availableKeys.join(", ") || "(none)"}`,
    );
  }

  return {
    aToken: strategy.aToken as Address,
    aavePool: strategy.aavePool as Address,
    environment: args.environment,
    network: args.network,
    source:
      args.recordPathOrDir === undefined
        ? state.initialStackRecordPath
        : (state.cutoffRecordPath ?? state.initialStackRecordPath),
    strategy: strategy.proxy as Address,
    strategyKey: strategy.key,
    token: strategy.vaultToken as Address,
    vault: state.vault.proxy as Address,
  };
}

function relativeToRepo(filePath: string): string {
  return filePath.replace(`${repoRoot}/`, "");
}

async function readSnapshot(args: {
  aToken: Address;
  publicClient: PublicClientLike;
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

  return {
    aTokenBalance,
    costBasis: rawCostBasis as bigint,
    strategyExposure,
    vaultBalance,
  };
}

async function writeAllocateAndWait(args: {
  account: WalletAccountLike;
  amount: bigint;
  publicClient: PublicClientLike;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
  walletClient: WalletClientLike;
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

async function writePartialDeallocateAndWait(args: {
  account: WalletAccountLike;
  amount: bigint;
  publicClient: PublicClientLike;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
  walletClient: WalletClientLike;
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

async function writeDeallocateAllAndWait(args: {
  account: WalletAccountLike;
  publicClient: PublicClientLike;
  strategy: Address;
  token: Address;
  vaultAbi: Abi;
  vault: Address;
  walletClient: WalletClientLike;
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

async function runEnvironment(args: {
  account: WalletAccountLike;
  deployment: ResolvedDeployment;
  dryRun: boolean;
  fullUnwind: boolean;
  mintAmount: bigint;
  partialAmount: bigint;
  publicClient: PublicClientLike;
  vaultAbi: Abi;
  walletClient: WalletClientLike;
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

const action: NewTaskActionFunction<StrategyAllocationSmokeTaskArgs> = async (
  { amount, dryRun, env, fullUnwind, partialAmount, record, strategyKey },
  hre,
) => {
  const environment = parseEnvironment(env);
  const networkName = hre.globalOptions.network;
  if (networkName === undefined || networkName === "default") {
    throw new Error(
      "missing required --network <network> for strategy allocation smoke",
    );
  }

  const { publicClient, walletClient } = await getClients(hre);
  if (walletClient.account === undefined) {
    throw new Error("selected network has no configured signer");
  }

  const account = walletClient.account;
  const vaultAbi = loadCompiledVaultAbi(repoRoot);

  renderSection("Setup", "Resolving operator, network, and deployment inputs");
  printKeyValue("Network:", networkName);
  printKeyValue("Environment:", environment);
  printKeyValue("Strategy key:", strategyKey);
  printKeyValue("Operator:", account.address);

  const resolveSpinner = ora("Resolving deployment metadata").start();
  const deployment = resolveDeployment({
    environment,
    network: networkName,
    recordPathOrDir: record,
    strategyKey,
  });
  resolveSpinner.succeed(
    `Resolved deployment metadata from ${deployment.source}`,
  );

  const decimals = await publicClient.readContract({
    address: deployment.token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const mintAmount = parseUnits(amount, decimals);
  const partialAmountValue =
    partialAmount === undefined
      ? mintAmount / 2n
      : parseUnits(partialAmount, decimals);

  if (mintAmount <= 0n) {
    throw new Error("amount must be greater than 0");
  }
  if (partialAmountValue <= 0n) {
    throw new Error("partial amount must be greater than 0");
  }
  if (partialAmountValue > mintAmount) {
    throw new Error("partial amount must be less than or equal to amount");
  }

  await runEnvironment({
    account,
    deployment,
    dryRun,
    fullUnwind,
    mintAmount,
    partialAmount: partialAmountValue,
    publicClient,
    vaultAbi,
    walletClient,
  });
};

export default action;
