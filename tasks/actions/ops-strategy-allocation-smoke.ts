import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { NewTaskActionFunction } from "hardhat/types/tasks";
import {
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";

import { getClients } from "../utils/one-off-ops.js";

const ENVIRONMENTS = ["staging", "testnet"] as const;
const repoRoot = process.cwd();

const vaultAbi = parseAbi([
  "function ALLOCATOR_ROLE() view returns (bytes32)",
  "function allocateVaultTokenToStrategy(address token,address strategy,uint256 amount)",
  "function deallocateVaultTokenFromStrategy(address token,address strategy,uint256 amount) returns (uint256 received)",
  "function deallocateAllVaultTokenFromStrategy(address token,address strategy) returns (uint256 received)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function isSupportedVaultToken(address vaultToken) view returns (bool)",
  "function isStrategyWhitelistedForVaultToken(address vaultToken,address strategy) view returns (bool)",
  "function paused() view returns (bool)",
  "function strategyCostBasis(address vaultToken,address strategy) view returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function mint(address to,uint256 amount)",
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
  skipMint: boolean;
  strategyKey: string;
};

type DeploymentSnapshot = {
  environment: string;
  network: {
    chainId: number;
    name: string;
  };
  strategies: Record<string, DeploymentStrategy>;
  vault?: {
    proxy: Address;
  };
};

type DeploymentStrategy = {
  aToken: Address;
  aavePool: Address;
  key: string;
  proxy: Address;
  vaultToken: Address;
};

type InitialStackManifest = {
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

function parseEnvironment(value: string): "all" | Environment {
  const normalized = value.toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "staging" || normalized === "testnet") return normalized;
  throw new Error(`unsupported environment: ${normalized}`);
}

function selectedEnvironments(env: "all" | Environment): Environment[] {
  return env === "all" ? [...ENVIRONMENTS] : [env];
}

function deploymentRegistryPath(
  environment: Environment,
  network: string,
): string {
  return join(repoRoot, "deployments", environment, `${network}.json`);
}

function initialStackRoot(environment: Environment, network: string): string {
  return join(
    repoRoot,
    "ignition",
    "deployments",
    "initial-stack",
    environment,
    network,
  );
}

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

function relativeToRepo(filePath: string): string {
  return filePath.replace(`${repoRoot}/`, "");
}

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

async function readSnapshot(args: {
  aToken: Address;
  publicClient: PublicClientLike;
  strategy: Address;
  token: Address;
  vault: Address;
}): Promise<Snapshot> {
  const [vaultBalance, aTokenBalance, strategyExposure, costBasis] =
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
        abi: vaultAbi,
        functionName: "strategyCostBasis",
        args: [args.token, args.strategy],
      }),
    ]);

  return { aTokenBalance, costBasis, strategyExposure, vaultBalance };
}

async function writeMintAndWait(args: {
  account: WalletAccountLike;
  amount: bigint;
  publicClient: PublicClientLike;
  token: Address;
  to: Address;
  walletClient: WalletClientLike;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.token,
    abi: erc20Abi,
    functionName: "mint",
    args: [args.to, args.amount],
  });

  const hash = await args.walletClient.writeContract(request);
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function writeAllocateAndWait(args: {
  account: WalletAccountLike;
  amount: bigint;
  publicClient: PublicClientLike;
  strategy: Address;
  token: Address;
  vault: Address;
  walletClient: WalletClientLike;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.vault,
    abi: vaultAbi,
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
  vault: Address;
  walletClient: WalletClientLike;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.vault,
    abi: vaultAbi,
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
  vault: Address;
  walletClient: WalletClientLike;
}): Promise<Hex> {
  const { request } = await args.publicClient.simulateContract({
    account: args.account,
    address: args.vault,
    abi: vaultAbi,
    functionName: "deallocateAllVaultTokenFromStrategy",
    args: [args.token, args.strategy],
  });

  const hash = await args.walletClient.writeContract(request);
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

function printSnapshot(
  label: string,
  snapshot: Snapshot,
  decimals: number,
  symbol: string,
): void {
  console.log(`  ${label}`);
  console.log(
    `    vault balance: ${formatUnits(snapshot.vaultBalance, decimals)} ${symbol}`,
  );
  console.log(
    `    strategy exposure: ${formatUnits(snapshot.strategyExposure, decimals)} ${symbol}`,
  );
  console.log(
    `    cost basis: ${formatUnits(snapshot.costBasis, decimals)} ${symbol}`,
  );
  console.log(
    `    aToken balance: ${formatUnits(snapshot.aTokenBalance, decimals)} ${symbol}`,
  );
}

async function runEnvironment(args: {
  account: WalletAccountLike;
  deployment: ResolvedDeployment;
  dryRun: boolean;
  fullUnwind: boolean;
  mintAmount: bigint;
  partialAmount: bigint;
  publicClient: PublicClientLike;
  skipMint: boolean;
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
    skipMint,
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

  console.log(`\n[${deployment.environment}] ${deployment.source}`);
  console.log(`  vault: ${deployment.vault}`);
  console.log(`  token: ${deployment.token} (${symbol}, ${decimals} decimals)`);
  console.log(`  strategy: ${deployment.strategy} [${deployment.strategyKey}]`);
  console.log(`  aToken: ${deployment.aToken}`);
  console.log(`  pool: ${deployment.aavePool}`);

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

  const initial = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
  });
  printSnapshot("before", initial, decimals, symbol);

  console.log(
    `  requested amount: ${formatUnits(mintAmount, decimals)} ${symbol}`,
  );
  console.log(
    `  partial deallocation: ${formatUnits(partialAmount, decimals)} ${symbol}`,
  );

  if (dryRun) {
    console.log("  dry-run only, no transactions sent");
    return;
  }

  if (!skipMint) {
    const mintHash = await writeMintAndWait({
      account,
      amount: mintAmount,
      publicClient,
      to: deployment.vault,
      token: deployment.token,
      walletClient,
    });
    console.log(`  mint tx: ${mintHash}`);
  } else {
    console.log("  skipping mint step");
  }

  const allocateHash = await writeAllocateAndWait({
    account,
    amount: mintAmount,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
    walletClient,
  });
  console.log(`  allocate tx: ${allocateHash}`);

  const afterAllocate = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
  });
  printSnapshot("after allocate", afterAllocate, decimals, symbol);

  const partialHash = await writePartialDeallocateAndWait({
    account,
    amount: partialAmount,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
    walletClient,
  });
  console.log(`  partial deallocate tx: ${partialHash}`);

  const afterPartial = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
  });
  printSnapshot("after partial deallocate", afterPartial, decimals, symbol);

  if (!fullUnwind) {
    return;
  }

  const unwindHash = await writeDeallocateAllAndWait({
    account,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
    walletClient,
  });
  console.log(`  deallocate-all tx: ${unwindHash}`);

  const afterUnwind = await readSnapshot({
    aToken: deployment.aToken,
    publicClient,
    strategy: deployment.strategy,
    token: deployment.token,
    vault: deployment.vault,
  });
  printSnapshot("after full unwind", afterUnwind, decimals, symbol);
}

const action: NewTaskActionFunction<StrategyAllocationSmokeTaskArgs> = async (
  { amount, dryRun, env, fullUnwind, partialAmount, skipMint, strategyKey },
  hre,
) => {
  const selectedEnv = parseEnvironment(env);
  const { publicClient, walletClient } = await getClients(hre);
  if (walletClient.account === undefined) {
    throw new Error("selected network has no configured signer");
  }
  const account = walletClient.account;
  const networkName = hre.globalOptions.network ?? "default";

  console.log(`signer: ${account.address}`);

  for (const environment of selectedEnvironments(selectedEnv)) {
    const deployment = resolveDeployment({
      environment,
      network: networkName,
      strategyKey,
    });
    if (!isAddress(deployment.token)) {
      throw new Error(`invalid token address in ${deployment.source}`);
    }
    const decimals = await publicClient.readContract({
      address: getAddress(deployment.token),
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
      skipMint,
      walletClient,
    });
  }
};

export default action;
