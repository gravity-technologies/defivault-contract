#!/usr/bin/env node

import "dotenv/config";

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, isAddress, type Address } from "viem";

import {
  buildTreasuryVaultStateReport,
  loadCompiledVaultAbi,
  readRegistryEnrichment,
} from "./treasury-vault-state-lib.js";

/**
 * Treasury vault state report CLI.
 *
 * This wrapper resolves CLI flags, connects to the requested Hardhat network,
 * loads the stable compiled vault ABI, and prints the human-facing Markdown
 * report to stdout. All non-report operational errors are printed to stderr.
 */

type CliOptions = {
  fromBlock?: bigint;
  maxEventsPerCategory: number;
  network?: string;
  registryPath?: string;
  toBlock?: bigint;
  vault?: Address;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

/** Print usage guidance and example invocations for the report CLI. */
function printUsage(): void {
  console.error(`Usage:
  npm run report:treasury-vault-state -- --network <network> --vault <vaultAddress> [--from-block <n>] [--to-block <n>] [--max-events-per-category <n>] [--registry deployments/<env>/<network>.json]

Examples:
  npm run report:treasury-vault-state -- --network sepolia --vault 0xAFe05e028A396c26c1bB73a4C9E1603d60836264 --from-block 8600000
  npm run report:treasury-vault-state -- --network sepolia --vault 0xAFe05e028A396c26c1bB73a4C9E1603d60836264 --registry deployments/staging/sepolia.json
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
      case "--registry":
        options.registryPath = requireValue();
        index += 1;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (options.network === undefined) {
    fail("--network is required");
  }
  if (options.vault === undefined) {
    fail("--vault is required");
  }

  return options;
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
  const registry =
    options.registryPath === undefined
      ? undefined
      : readRegistryEnrichment({
          filePath: resolve(REPO_ROOT, options.registryPath),
          vaultAddress: options.vault!,
        });

  const report = await buildTreasuryVaultStateReport({
    chainId,
    fromBlock: options.fromBlock,
    maxEventsPerCategory: options.maxEventsPerCategory,
    networkName: options.network!,
    publicClient,
    registry,
    toBlock: options.toBlock,
    vaultAbi,
    vaultAddress: options.vault!,
  });

  process.stdout.write(report.markdown);
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
