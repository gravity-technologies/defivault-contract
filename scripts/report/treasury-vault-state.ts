#!/usr/bin/env node

import "dotenv/config";

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, isAddress, type Address } from "viem";

import { resolveCurrentDeploymentState } from "../deploy/operation-records.js";
import {
  buildTreasuryVaultStateReport,
  loadCompiledVaultAbi,
  type DeploymentStateEnrichment,
} from "./treasury-vault-state-lib.js";

/**
 * Treasury vault state report CLI.
 *
 * This wrapper resolves CLI flags, connects to the requested Hardhat network,
 * loads the stable compiled vault ABI, and prints the human-facing Markdown
 * report to stdout. All non-report operational errors are printed to stderr.
 */

type CliOptions = {
  env?: string;
  fromBlock?: bigint;
  maxEventsPerCategory: number;
  network?: string;
  recordPath?: string;
  toBlock?: bigint;
  vault?: Address;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

/** Print usage guidance and example invocations for the report CLI. */
function printUsage(): void {
  console.error(`Usage:
  npm run report:treasury-vault-state -- --network <network> --env <staging|testnet|production> [--record <path>] [--vault <vaultAddress>] [--from-block <n>] [--to-block <n>] [--max-events-per-category <n>]

Examples:
  npm run report:treasury-vault-state -- --network sepolia --env staging
  npm run report:treasury-vault-state -- --network sepolia --record deployment-records/staging/sepolia/<run>/record.json
  npm run report:treasury-vault-state -- --network sepolia --vault 0xAFe05e028A396c26c1bB73a4C9E1603d60836264 --from-block 8600000
`);
}

/** Exit the CLI with one formatted fatal error. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Parse CLI flags into a normalized report-options object. */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    maxEventsPerCategory: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      fail(`unexpected argument: ${arg}`);
    }

    const next = argv[index + 1];
    const requireValue = () => {
      if (next === undefined || next.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      return next;
    };

    switch (arg) {
      case "--network":
        options.network = requireValue();
        index += 1;
        break;
      case "--env":
        options.env = requireValue();
        index += 1;
        break;
      case "--vault": {
        const value = requireValue();
        if (!isAddress(value)) {
          fail(`invalid vault address: ${value}`);
        }
        options.vault = getAddress(value);
        index += 1;
        break;
      }
      case "--from-block":
        options.fromBlock = parseBlockValue(requireValue(), "--from-block");
        index += 1;
        break;
      case "--to-block":
        options.toBlock = parseBlockValue(requireValue(), "--to-block");
        index += 1;
        break;
      case "--max-events-per-category":
        options.maxEventsPerCategory = parsePositiveInteger(
          requireValue(),
          "--max-events-per-category",
        );
        index += 1;
        break;
      case "--record":
        options.recordPath = requireValue();
        index += 1;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (options.network === undefined) {
    fail("--network is required");
  }
  if (
    options.vault === undefined &&
    options.recordPath === undefined &&
    options.env === undefined
  ) {
    fail("provide at least one of --vault, --record, or --env");
  }

  return options;
}

function buildDeploymentStateEnrichment(args: {
  network: string;
  recordPath?: string;
  repoRoot: string;
  vaultAddress?: Address;
  env?: string;
}): { deploymentState?: DeploymentStateEnrichment; vaultAddress?: Address } {
  if (args.recordPath === undefined && args.env === undefined) {
    return { deploymentState: undefined, vaultAddress: args.vaultAddress };
  }

  const state = resolveCurrentDeploymentState({
    environment: args.env,
    network: args.network,
    recordPathOrDir: args.recordPath,
    repoRoot: args.repoRoot,
  });
  if (state.vault === undefined) {
    throw new Error("resolved deployment state is missing vault data");
  }
  if (
    args.vaultAddress !== undefined &&
    getAddress(state.vault.proxy) !== getAddress(args.vaultAddress)
  ) {
    throw new Error(
      `resolved deployment state vault mismatch: expected ${args.vaultAddress}, found ${state.vault.proxy}`,
    );
  }

  return {
    deploymentState: {
      nativeBridge:
        state.nativeBridge === undefined
          ? undefined
          : { proxy: getAddress(state.nativeBridge.proxy) },
      strategies: Object.fromEntries(
        Object.entries(state.strategies).map(([key, strategy]) => [
          key,
          {
            displayName: strategy.displayName,
            key: strategy.key,
            proxy: getAddress(strategy.proxy),
          },
        ]),
      ),
      vault: { proxy: getAddress(state.vault.proxy) },
      yieldRecipientTimelock:
        state.yieldRecipientTimelock === undefined
          ? undefined
          : {
              controller: getAddress(state.yieldRecipientTimelock.controller),
            },
    },
    vaultAddress: getAddress(state.vault.proxy),
  };
}

/** Parse one non-negative block-number flag into bigint form. */
function parseBlockValue(value: string, flag: string): bigint {
  if (!/^\d+$/.test(value)) {
    fail(`${flag} must be a non-negative integer`);
  }
  return BigInt(value);
}

/** Parse one positive integer CLI flag. */
function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    fail(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

/** Connect to the requested network, build the report, and print Markdown to stdout. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { network } = await import("hardhat");
  const { viem } = await network.connect(options.network!);
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const vaultAbi = loadCompiledVaultAbi(REPO_ROOT);
  const resolvedState = buildDeploymentStateEnrichment({
    env: options.env,
    network: options.network!,
    recordPath: options.recordPath,
    repoRoot: REPO_ROOT,
    vaultAddress: options.vault,
  });
  if (resolvedState.vaultAddress === undefined) {
    fail("--vault is required when --env/--record are not provided");
  }

  const report = await buildTreasuryVaultStateReport({
    chainId,
    deploymentState: resolvedState.deploymentState,
    fromBlock: options.fromBlock,
    maxEventsPerCategory: options.maxEventsPerCategory,
    networkName: options.network!,
    publicClient,
    toBlock: options.toBlock,
    vaultAbi,
    vaultAddress: resolvedState.vaultAddress,
  });

  process.stdout.write(report.markdown);
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
