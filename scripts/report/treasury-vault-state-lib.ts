import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";

/**
 * Treasury-vault state report builder.
 *
 * This module gathers the current human-facing state of one treasury vault plus
 * a bounded set of significant runtime events. It intentionally stays inside
 * the existing onchain read surface and raw-token accounting model:
 * - no USD pricing
 * - no deployment-history reconstruction beyond optional deployment-state enrichment
 * - no storage-layout introspection
 *
 * The report is meant for operators, so degraded reads are annotated rather
 * than treated as hard failures whenever the vault itself remains readable.
 */

const ERC20_METADATA_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const YIELD_STRATEGY_ABI = parseAbi([
  "function name() view returns (string)",
  "function tvlTokens(address vaultToken) view returns (address[] memory)",
  "function positionBreakdown(address vaultToken) view returns ((address token,uint256 amount,uint8 kind)[] memory)",
  "function strategyExposure(address vaultToken) view returns (uint256)",
]);
const RELEVANT_EVENT_NAMES = [
  "VaultTokenConfigUpdated",
  "VaultTokenStrategyConfigUpdated",
  "VaultTokenAllocatedToStrategy",
  "VaultTokenAllocationSpentMismatch",
  "VaultTokenDeallocatedFromStrategy",
  "StrategyReportedReceivedMismatch",
  "YieldHarvested",
  "BridgeSentToL2",
  "VaultPaused",
  "VaultUnpaused",
  "YieldRecipientTimelockControllerUpdated",
  "YieldRecipientUpdated",
  "NativeBridgeGatewayUpdated",
  "TrackedTvlTokenOverrideUpdated",
  "NativeSweptToYieldRecipient",
  "StrategyRemovalCheckFailed",
] as const;
const EVENT_CATEGORY_BY_NAME = {
  BridgeSentToL2: "Bridge",
  NativeBridgeGatewayUpdated: "Lifecycle & Config",
  NativeSweptToYieldRecipient: "Yield",
  StrategyRemovalCheckFailed: "Warnings & Anomalies",
  StrategyReportedReceivedMismatch: "Warnings & Anomalies",
  TrackedTvlTokenOverrideUpdated: "Lifecycle & Config",
  VaultPaused: "Lifecycle & Config",
  VaultTokenAllocatedToStrategy: "Allocations & Deallocations",
  VaultTokenAllocationSpentMismatch: "Warnings & Anomalies",
  VaultTokenConfigUpdated: "Lifecycle & Config",
  VaultTokenDeallocatedFromStrategy: "Allocations & Deallocations",
  VaultTokenStrategyConfigUpdated: "Lifecycle & Config",
  VaultUnpaused: "Lifecycle & Config",
  YieldHarvested: "Yield",
  YieldRecipientTimelockControllerUpdated: "Lifecycle & Config",
  YieldRecipientUpdated: "Lifecycle & Config",
} as const;
const EVENT_CATEGORIES = [
  "Lifecycle & Config",
  "Allocations & Deallocations",
  "Yield",
  "Bridge",
  "Warnings & Anomalies",
] as const;
const LOG_CHUNK_SIZE = 10_000n;

type EventCategory = (typeof EVENT_CATEGORIES)[number];

export type DeploymentStateEnrichment = {
  nativeBridge?: {
    proxy: Address;
  };
  strategies: Record<
    string,
    {
      displayName: string;
      key: string;
      proxy: Address;
    }
  >;
  vault?: {
    proxy: Address;
  };
  yieldRecipientTimelock?: {
    controller: Address;
  };
};

type TokenMetadata = {
  address: Address;
  decimals?: number;
  name?: string;
  symbol?: string;
};

type TokenTotals = {
  idle: bigint;
  skippedStrategies: bigint;
  strategy: bigint;
  total: bigint;
};

type VaultTokenStrategyConfig = {
  active: boolean;
  cap: bigint;
  whitelisted: boolean;
};

type PositionComponent = {
  amount: bigint;
  kind: bigint | number;
  token: Address;
};

type HistoricalEvent = {
  args: Record<string, unknown>;
  blockNumber: bigint;
  eventName: string;
  logIndex: number;
  transactionHash: `0x${string}`;
  transactionIndex: number;
};

type StrategyPair = {
  strategy: Address;
  vaultToken: Address;
};

type StrategyReportRow = {
  costBasis: bigint | null;
  degradedSurfaces: string[];
  displayName: string;
  exposure: bigint | null;
  harvestableYield: bigint | null;
  lifecycle: string;
  registryKey?: string;
  strategy: Address;
  token: Address;
  tokenConfig: VaultTokenStrategyConfig;
  tvlTokens: Address[] | null;
  vaultPositionBreakdown: PositionComponent[] | null;
};

type TrackedTokenRow = {
  metadata: TokenMetadata;
  sourceLabel: string;
  totals: TokenTotals;
};

type ReportBuildOptions = {
  chainId: number;
  networkName: string;
  publicClient: PublicClient;
  deploymentState?: DeploymentStateEnrichment;
  toBlock?: bigint;
  vaultAbi: Abi;
  vaultAddress: Address;
};

type ReportRequest = ReportBuildOptions & {
  fromBlock?: bigint;
  maxEventsPerCategory: number;
};

export type TreasuryVaultReportResult = {
  markdown: string;
  warnings: string[];
};

type HistoricalStartResolution = {
  discoveredDeploymentBlock?: bigint;
  fromBlock: bigint;
  partialHistory: boolean;
  toBlock: bigint;
  warnings: string[];
};

type VaultSummary = {
  bridgeHub: Address;
  grvtBridgeProxyFeeToken: Address;
  l2ChainId: bigint;
  l2ExchangeRecipient: Address;
  nativeBridgeGateway: Address;
  paused: boolean;
  wrappedNativeToken: Address;
  yieldRecipient: Address;
  yieldRecipientTimelockController: Address;
};

/**
 * Read the compiled vault artifact ABI from the stable project artifacts tree.
 */
export function loadCompiledVaultAbi(repoRoot: string): Abi {
  const artifactPath = resolve(
    repoRoot,
    "artifacts/contracts/vault/GRVTL1TreasuryVault.sol/GRVTL1TreasuryVault.json",
  );
  if (!existsSync(artifactPath)) {
    throw new Error(`compiled vault artifact not found: ${artifactPath}`);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    abi?: Abi;
  };
  if (artifact.abi === undefined) {
    throw new Error(`compiled vault artifact missing abi: ${artifactPath}`);
  }
  return artifact.abi;
}

/** Convert one whitelisted/active config tuple into the human lifecycle label. */
export function lifecycleLabel(config: VaultTokenStrategyConfig): string {
  if (config.whitelisted && config.active) return "active";
  if (!config.whitelisted && config.active) return "withdraw-only";
  if (!config.whitelisted && !config.active) return "removed";
  return "unexpected";
}

/** Classify why a token is currently surfaced in the tracked-TVL set. */
export function trackedTokenSourceLabel(args: {
  strategyDeclared: boolean;
  supported: boolean;
}): string {
  if (args.supported && args.strategyDeclared) {
    return "supported + strategy-declared";
  }
  if (args.supported) return "supported";
  if (args.strategyDeclared) return "strategy-declared";
  return "unknown / possible override";
}

/** Return the fixed report category for one supported vault event name. */
export function eventCategory(eventName: string): EventCategory {
  const category =
    EVENT_CATEGORY_BY_NAME[eventName as keyof typeof EVENT_CATEGORY_BY_NAME];
  if (category === undefined) {
    throw new Error(`unsupported event category for ${eventName}`);
  }
  return category;
}

/** Sort historical events newest-first for operator-facing rendering. */
export function sortHistoricalEvents(
  left: HistoricalEvent,
  right: HistoricalEvent,
): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber > right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex > right.transactionIndex ? -1 : 1;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex > right.logIndex ? -1 : 1;
  }
  return 0;
}

/** Build the full Markdown report plus warning list for one vault. */
export async function buildTreasuryVaultStateReport(
  args: ReportRequest,
): Promise<TreasuryVaultReportResult> {
  const warnings = new Set<string>();
  const degradedWarnings = new Set<string>();
  const historicalRange = await resolveHistoricalRange({
    fromBlock: args.fromBlock,
    publicClient: args.publicClient,
    toBlock: args.toBlock,
    vaultAddress: args.vaultAddress,
  });
  for (const warning of historicalRange.warnings) {
    warnings.add(warning);
  }

  const summary = await readVaultSummary(args);
  const history = await collectHistoricalEvents({
    fromBlock: historicalRange.fromBlock,
    publicClient: args.publicClient,
    toBlock: historicalRange.toBlock,
    vaultAbi: args.vaultAbi,
    vaultAddress: args.vaultAddress,
  });
  const successfulStrategyDeclaredTokens = new Set<string>();
  const tokenMetadataCache = new Map<string, Promise<TokenMetadata>>();
  const registryStrategyByAddress = buildRegistryStrategyLookup(
    args.deploymentState,
  );
  const supportedTokens = await readSupportedVaultTokens(args);
  const historicalPairs = recoverHistoricalPairs(history);
  const tokenUniverse = new Set<string>(
    supportedTokens.map((token) => token.toLowerCase()),
  );
  for (const pair of historicalPairs.values()) {
    tokenUniverse.add(pair.vaultToken.toLowerCase());
  }

  const currentPairs = new Map<string, StrategyPair>();
  for (const tokenLower of tokenUniverse) {
    const token = getAddress(tokenLower as Address);
    for (const strategy of await readCurrentVaultTokenStrategies(args, token)) {
      currentPairs.set(pairKey(token, strategy), {
        strategy,
        vaultToken: token,
      });
    }
  }
  for (const [key, pair] of historicalPairs) {
    currentPairs.set(key, pair);
  }

  const trackedTvl = await readTrackedTvl(args);
  const trackedTokenRows: TrackedTokenRow[] = [];
  for (const token of trackedTvl.tokens) {
    const metadata = await readTokenMetadataCached(
      args.publicClient,
      tokenMetadataCache,
      token,
      degradedWarnings,
    );
    if (trackedTvl.statuses[token].skippedStrategies > 0n) {
      warnings.add(
        `Tracked TVL token ${tokenLabel(metadata)} is a lower bound because ${trackedTvl.statuses[token].skippedStrategies.toString()} strategy read(s) were skipped.`,
      );
    }
    trackedTokenRows.push({
      metadata,
      sourceLabel: "unknown / possible override",
      totals: trackedTvl.statuses[token],
    });
  }

  const strategyRows: StrategyReportRow[] = [];
  for (const pair of Array.from(currentPairs.values()).sort(comparePairs)) {
    const row = await readStrategyRow({
      pair,
      publicClient: args.publicClient,
      registryStrategyByAddress,
      successfulStrategyDeclaredTokens,
      tokenMetadataCache,
      vaultAbi: args.vaultAbi,
      vaultAddress: args.vaultAddress,
    });
    for (const surface of row.degradedSurfaces) {
      degradedWarnings.add(
        `Strategy ${row.strategy} for vault token ${row.token} has degraded reads: ${surface}.`,
      );
    }
    strategyRows.push(row);
  }

  const supportedTokenSet = new Set(
    supportedTokens.map((token) => token.toLowerCase()),
  );
  for (const row of trackedTokenRows) {
    row.sourceLabel = trackedTokenSourceLabel({
      strategyDeclared: successfulStrategyDeclaredTokens.has(
        row.metadata.address.toLowerCase(),
      ),
      supported: supportedTokenSet.has(row.metadata.address.toLowerCase()),
    });
  }

  for (const warning of degradedWarnings) {
    warnings.add(warning);
  }

  const markdown = await renderReport({
    chainId: args.chainId,
    currentBlock: historicalRange.toBlock,
    fromBlock: historicalRange.fromBlock,
    history,
    maxEventsPerCategory: args.maxEventsPerCategory,
    networkName: args.networkName,
    registry: args.deploymentState,
    strategyRows,
    summary,
    supportedTokens,
    tokenMetadataCache,
    trackedTokenRows,
    vaultAddress: args.vaultAddress,
    vaultAbi: args.vaultAbi,
    warnings: Array.from(warnings),
    publicClient: args.publicClient,
    deploymentBlock: historicalRange.discoveredDeploymentBlock,
    partialHistory: historicalRange.partialHistory,
  });

  return {
    markdown,
    warnings: Array.from(warnings),
  };
}

/** Resolve the query range and deployment-block warnings for one report run. */
async function resolveHistoricalRange(args: {
  fromBlock?: bigint;
  publicClient: PublicClient;
  toBlock?: bigint;
  vaultAddress: Address;
}): Promise<HistoricalStartResolution> {
  const warnings: string[] = [];
  const latestBlock =
    args.toBlock ?? (await args.publicClient.getBlockNumber());
  const discovery = await discoverDeploymentBlock(
    args.publicClient,
    args.vaultAddress,
    latestBlock,
  );

  if (args.fromBlock === undefined) {
    if (discovery.block === undefined) {
      if (discovery.archiveUnavailable) {
        throw new Error(
          "could not discover deployment block from RPC history; rerun with --from-block",
        );
      }
      throw new Error("could not determine vault deployment block");
    }
    return {
      discoveredDeploymentBlock: discovery.block,
      fromBlock: discovery.block,
      partialHistory: false,
      toBlock: latestBlock,
      warnings,
    };
  }

  if (args.fromBlock > latestBlock) {
    throw new Error("--from-block cannot be greater than --to-block/latest");
  }

  let partialHistory = false;
  if (discovery.block !== undefined && args.fromBlock > discovery.block) {
    partialHistory = true;
    warnings.push(
      `History is partial from block ${args.fromBlock.toString()} onward; the vault was deployed at block ${discovery.block.toString()}.`,
    );
  } else if (discovery.archiveUnavailable) {
    warnings.push(
      "Could not validate whether the provided --from-block predates deployment because historic code lookup is unavailable on this RPC.",
    );
  }

  return {
    discoveredDeploymentBlock: discovery.block,
    fromBlock: args.fromBlock,
    partialHistory,
    toBlock: latestBlock,
    warnings,
  };
}

/** Find the first block where the vault address has code using binary search. */
async function discoverDeploymentBlock(
  publicClient: PublicClient,
  vaultAddress: Address,
  latestBlock: bigint,
): Promise<{ archiveUnavailable: boolean; block?: bigint }> {
  let latestCode: `0x${string}` | undefined;
  try {
    latestCode = await publicClient.getCode({ address: vaultAddress });
  } catch {
    throw new Error(`failed to read code for vault ${vaultAddress}`);
  }

  if (latestCode === undefined || latestCode === "0x") {
    throw new Error(`vault address has no code: ${vaultAddress}`);
  }

  try {
    const genesisCode = await publicClient.getCode({
      address: vaultAddress,
      blockNumber: 0n,
    });
    if (genesisCode !== undefined && genesisCode !== "0x") {
      return { archiveUnavailable: false, block: 0n };
    }
  } catch {
    return { archiveUnavailable: true };
  }

  let low = 0n;
  let high = latestBlock;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    const code = await publicClient.getCode({
      address: vaultAddress,
      blockNumber: middle,
    });
    if (code !== undefined && code !== "0x") {
      high = middle;
    } else {
      low = middle;
    }
  }

  return { archiveUnavailable: false, block: high };
}

/** Read the core vault config summary from the concrete vault ABI. */
async function readVaultSummary(
  args: ReportBuildOptions,
): Promise<VaultSummary> {
  const read = async <T>(functionName: string): Promise<T> =>
    (await args.publicClient.readContract({
      address: args.vaultAddress,
      abi: args.vaultAbi,
      functionName,
    })) as T;

  return {
    bridgeHub: await read<Address>("bridgeHub"),
    grvtBridgeProxyFeeToken: await read<Address>("grvtBridgeProxyFeeToken"),
    l2ChainId: await read<bigint>("l2ChainId"),
    l2ExchangeRecipient: await read<Address>("l2ExchangeRecipient"),
    nativeBridgeGateway: await read<Address>("nativeBridgeGateway"),
    paused: await read<boolean>("paused"),
    wrappedNativeToken: await read<Address>("wrappedNativeToken"),
    yieldRecipient: await read<Address>("yieldRecipient"),
    yieldRecipientTimelockController: await read<Address>(
      "yieldRecipientTimelockController",
    ),
  };
}

/** Read the current supported vault tokens. */
async function readSupportedVaultTokens(
  args: ReportBuildOptions,
): Promise<Address[]> {
  return (await args.publicClient.readContract({
    address: args.vaultAddress,
    abi: args.vaultAbi,
    functionName: "getSupportedVaultTokens",
  })) as Address[];
}

/** Read the currently tracked strategies for one vault token. */
async function readCurrentVaultTokenStrategies(
  args: ReportBuildOptions,
  token: Address,
): Promise<Address[]> {
  return (await args.publicClient.readContract({
    address: args.vaultAddress,
    abi: args.vaultAbi,
    functionName: "getVaultTokenStrategies",
    args: [token],
  })) as Address[];
}

/** Read the tracked TVL token list plus conservative totals in one call. */
async function readTrackedTvl(args: ReportBuildOptions): Promise<{
  statuses: Record<string, TokenTotals>;
  tokens: Address[];
}> {
  const [tokens, statuses] = (await args.publicClient.readContract({
    address: args.vaultAddress,
    abi: args.vaultAbi,
    functionName: "trackedTvlTokenTotals",
  })) as [Address[], TokenTotals[]];

  const byToken: Record<string, TokenTotals> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    byToken[getAddress(tokens[index])] = statuses[index];
  }

  return {
    statuses: byToken,
    tokens: tokens.map((token) => getAddress(token)),
  };
}

/** Fetch logs in fixed block chunks and decode only the supported vault events. */
async function collectHistoricalEvents(args: {
  fromBlock: bigint;
  publicClient: PublicClient;
  toBlock: bigint;
  vaultAbi: Abi;
  vaultAddress: Address;
}): Promise<HistoricalEvent[]> {
  const events: HistoricalEvent[] = [];
  for (const eventName of RELEVANT_EVENT_NAMES) {
    for (
      let chunkStart = args.fromBlock;
      chunkStart <= args.toBlock;
      chunkStart += LOG_CHUNK_SIZE
    ) {
      const chunkEnd =
        chunkStart + LOG_CHUNK_SIZE - 1n < args.toBlock
          ? chunkStart + LOG_CHUNK_SIZE - 1n
          : args.toBlock;
      const logs = await args.publicClient.getContractEvents({
        address: args.vaultAddress,
        abi: args.vaultAbi,
        eventName,
        fromBlock: chunkStart,
        strict: false,
        toBlock: chunkEnd,
      });
      for (const log of logs) {
        if (
          log.blockNumber === null ||
          log.logIndex === null ||
          log.transactionHash === null ||
          log.transactionIndex === null
        ) {
          continue;
        }
        events.push({
          args: (log.args ?? {}) as unknown as Record<string, unknown>,
          blockNumber: log.blockNumber,
          eventName: log.eventName,
          logIndex: Number(log.logIndex),
          transactionHash: log.transactionHash,
          transactionIndex: Number(log.transactionIndex),
        });
      }
    }
  }
  return events.sort(sortHistoricalEvents);
}

/** Recover all `(vaultToken, strategy)` pairs ever seen in config-update history. */
function recoverHistoricalPairs(
  events: HistoricalEvent[],
): Map<string, StrategyPair> {
  const pairs = new Map<string, StrategyPair>();
  for (const event of events) {
    if (event.eventName !== "VaultTokenStrategyConfigUpdated") continue;
    const vaultToken = normalizeLoggedAddress(event.args.vaultToken);
    const strategy = normalizeLoggedAddress(event.args.strategy);
    if (vaultToken === undefined || strategy === undefined) continue;
    pairs.set(pairKey(vaultToken, strategy), { strategy, vaultToken });
  }
  return pairs;
}

/** Read one strategy row, tolerating non-critical strategy read failures. */
async function readStrategyRow(args: {
  pair: StrategyPair;
  publicClient: PublicClient;
  registryStrategyByAddress: Map<string, { displayName: string; key: string }>;
  successfulStrategyDeclaredTokens: Set<string>;
  tokenMetadataCache: Map<string, Promise<TokenMetadata>>;
  vaultAbi: Abi;
  vaultAddress: Address;
}): Promise<StrategyReportRow> {
  const degradedSurfaces: string[] = [];
  let name: string = args.pair.strategy;
  try {
    name = (await args.publicClient.readContract({
      address: args.pair.strategy,
      abi: YIELD_STRATEGY_ABI,
      functionName: "name",
    })) as string;
  } catch {
    degradedSurfaces.push("name()");
  }

  const config = (await args.publicClient.readContract({
    address: args.vaultAddress,
    abi: args.vaultAbi,
    functionName: "getVaultTokenStrategyConfig",
    args: [args.pair.vaultToken, args.pair.strategy],
  })) as VaultTokenStrategyConfig;

  let costBasis: bigint | null = null;
  try {
    costBasis = (await args.publicClient.readContract({
      address: args.vaultAddress,
      abi: args.vaultAbi,
      functionName: "strategyCostBasis",
      args: [args.pair.vaultToken, args.pair.strategy],
    })) as bigint;
  } catch {
    degradedSurfaces.push("strategyCostBasis()");
  }

  let harvestableYield: bigint | null = null;
  try {
    harvestableYield = (await args.publicClient.readContract({
      address: args.vaultAddress,
      abi: args.vaultAbi,
      functionName: "harvestableYield",
      args: [args.pair.vaultToken, args.pair.strategy],
    })) as bigint;
  } catch {
    degradedSurfaces.push("harvestableYield()");
  }

  let exposure: bigint | null = null;
  try {
    exposure = (await args.publicClient.readContract({
      address: args.pair.strategy,
      abi: YIELD_STRATEGY_ABI,
      functionName: "strategyExposure",
      args: [args.pair.vaultToken],
    })) as bigint;
  } catch {
    degradedSurfaces.push("strategyExposure()");
  }

  let tvlTokens: Address[] | null = null;
  try {
    tvlTokens = (await args.publicClient.readContract({
      address: args.pair.strategy,
      abi: YIELD_STRATEGY_ABI,
      functionName: "tvlTokens",
      args: [args.pair.vaultToken],
    })) as Address[];
    for (const token of tvlTokens) {
      args.successfulStrategyDeclaredTokens.add(token.toLowerCase());
      await readTokenMetadataCached(
        args.publicClient,
        args.tokenMetadataCache,
        token,
        new Set(),
      );
    }
  } catch {
    degradedSurfaces.push("tvlTokens()");
  }

  let vaultPositionBreakdown: PositionComponent[] | null = null;
  try {
    vaultPositionBreakdown = (await args.publicClient.readContract({
      address: args.vaultAddress,
      abi: args.vaultAbi,
      functionName: "strategyPositionBreakdown",
      args: [args.pair.vaultToken, args.pair.strategy],
    })) as PositionComponent[];
    for (const component of vaultPositionBreakdown) {
      await readTokenMetadataCached(
        args.publicClient,
        args.tokenMetadataCache,
        component.token,
        new Set(),
      );
    }
  } catch {
    degradedSurfaces.push("strategyPositionBreakdown()");
  }

  const registryMatch = args.registryStrategyByAddress.get(
    args.pair.strategy.toLowerCase(),
  );

  return {
    costBasis,
    degradedSurfaces,
    displayName: name,
    exposure,
    harvestableYield,
    lifecycle: lifecycleLabel(config),
    registryKey: registryMatch?.key,
    strategy: args.pair.strategy,
    token: args.pair.vaultToken,
    tokenConfig: config,
    tvlTokens,
    vaultPositionBreakdown,
  };
}

/** Read ERC20 metadata once per token and cache the result. */
async function readTokenMetadataCached(
  publicClient: PublicClient,
  cache: Map<string, Promise<TokenMetadata>>,
  token: Address,
  degradedWarnings: Set<string>,
): Promise<TokenMetadata> {
  const normalized = getAddress(token);
  let pending = cache.get(normalized.toLowerCase());
  if (pending === undefined) {
    pending = readTokenMetadata(publicClient, normalized, degradedWarnings);
    cache.set(normalized.toLowerCase(), pending);
  }
  return pending;
}

/** Read symbol/name/decimals for one token, tolerating metadata failures. */
async function readTokenMetadata(
  publicClient: PublicClient,
  token: Address,
  degradedWarnings: Set<string>,
): Promise<TokenMetadata> {
  const metadata: TokenMetadata = { address: token };
  try {
    metadata.decimals = Number(
      (await publicClient.readContract({
        address: token,
        abi: ERC20_METADATA_ABI,
        functionName: "decimals",
      })) as number | bigint,
    );
    metadata.name = (await publicClient.readContract({
      address: token,
      abi: ERC20_METADATA_ABI,
      functionName: "name",
    })) as string;
    metadata.symbol = (await publicClient.readContract({
      address: token,
      abi: ERC20_METADATA_ABI,
      functionName: "symbol",
    })) as string;
  } catch {
    degradedWarnings.add(`Metadata unavailable for token ${token}.`);
  }
  return metadata;
}

/** Render the final Markdown output from the assembled report data. */
async function renderReport(args: {
  chainId: number;
  currentBlock: bigint;
  deploymentBlock?: bigint;
  fromBlock: bigint;
  history: HistoricalEvent[];
  maxEventsPerCategory: number;
  networkName: string;
  partialHistory: boolean;
  publicClient: PublicClient;
  registry?: DeploymentStateEnrichment;
  strategyRows: StrategyReportRow[];
  summary: VaultSummary;
  supportedTokens: Address[];
  tokenMetadataCache: Map<string, Promise<TokenMetadata>>;
  trackedTokenRows: TrackedTokenRow[];
  vaultAbi: Abi;
  vaultAddress: Address;
  warnings: string[];
}): Promise<string> {
  const lines: string[] = [];

  lines.push("# Treasury Vault State");
  lines.push("");
  if (args.warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of args.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  lines.push("## Vault Summary");
  lines.push(`- Vault: \`${args.vaultAddress}\``);
  lines.push(`- Network: ${args.networkName} (${args.chainId})`);
  lines.push(`- Query block: ${args.currentBlock.toString()}`);
  lines.push(`- History start block: ${args.fromBlock.toString()}`);
  if (args.deploymentBlock !== undefined) {
    lines.push(
      `- Discovered deployment block: ${args.deploymentBlock.toString()}`,
    );
  }
  lines.push(`- Paused: ${args.summary.paused ? "yes" : "no"}`);
  lines.push(`- BridgeHub: \`${args.summary.bridgeHub}\``);
  lines.push(
    `- GRVT bridge proxy fee token: \`${args.summary.grvtBridgeProxyFeeToken}\``,
  );
  lines.push(`- Wrapped native token: \`${args.summary.wrappedNativeToken}\``);
  lines.push(
    `- Native bridge gateway: \`${args.summary.nativeBridgeGateway}\``,
  );
  lines.push(`- Yield recipient: \`${args.summary.yieldRecipient}\``);
  lines.push(
    `- Yield recipient timelock controller: \`${args.summary.yieldRecipientTimelockController}\``,
  );
  lines.push(`- L2 chain id: ${args.summary.l2ChainId.toString()}`);
  lines.push(
    `- L2 exchange recipient: \`${args.summary.l2ExchangeRecipient}\``,
  );
  if (
    args.registry?.nativeBridge?.proxy !== undefined &&
    getAddress(args.registry.nativeBridge.proxy) ===
      args.summary.nativeBridgeGateway
  ) {
    lines.push(`- Registry native bridge: matched`);
  }
  if (
    args.registry?.yieldRecipientTimelock?.controller !== undefined &&
    getAddress(args.registry.yieldRecipientTimelock.controller) ===
      args.summary.yieldRecipientTimelockController
  ) {
    lines.push(`- Registry timelock: matched`);
  }
  lines.push("");

  lines.push("## Supported Vault Tokens");
  if (args.supportedTokens.length === 0) {
    lines.push("_No supported vault tokens._");
  } else {
    for (const token of args.supportedTokens.sort()) {
      const metadata = await readTokenMetadataCached(
        args.publicClient,
        args.tokenMetadataCache,
        token,
        new Set(),
      );
      const config = (await args.publicClient.readContract({
        address: args.vaultAddress,
        abi: args.vaultAbi,
        functionName: "getVaultTokenConfig",
        args: [token],
      })) as { supported: boolean };
      const idleBalance = (await args.publicClient.readContract({
        address: args.vaultAddress,
        abi: args.vaultAbi,
        functionName: "idleTokenBalance",
        args: [token],
      })) as bigint;
      const rebalanceAmount =
        token === args.summary.wrappedNativeToken
          ? ((await args.publicClient.readContract({
              address: args.vaultAddress,
              abi: args.vaultAbi,
              functionName: "availableNativeForRebalance",
            })) as bigint)
          : ((await args.publicClient.readContract({
              address: args.vaultAddress,
              abi: args.vaultAbi,
              functionName: "availableErc20ForRebalance",
              args: [token],
            })) as bigint);
      lines.push(`### ${tokenLabel(metadata)}`);
      lines.push(`- Address: \`${token}\``);
      lines.push(`- Supported: ${config.supported ? "yes" : "no"}`);
      lines.push(`- Idle balance: ${formatTokenAmount(idleBalance, metadata)}`);
      lines.push(
        `- Immediate rebalance: ${formatTokenAmount(rebalanceAmount, metadata)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Tracked TVL");
  lines.push(
    "Tracked-token source labels are heuristic for current state. Admin override provenance is only inferable from history, not guaranteed from current reads.",
  );
  if (args.trackedTokenRows.length === 0) {
    lines.push("");
    lines.push("_No tracked TVL tokens._");
  } else {
    for (const row of args.trackedTokenRows.sort((left, right) =>
      left.metadata.address.localeCompare(right.metadata.address),
    )) {
      lines.push(`### ${tokenLabel(row.metadata)}`);
      lines.push(`- Address: \`${row.metadata.address}\``);
      lines.push(`- Source: ${row.sourceLabel}`);
      lines.push(`- Idle: ${formatTokenAmount(row.totals.idle, row.metadata)}`);
      lines.push(
        `- Strategy: ${formatTokenAmount(row.totals.strategy, row.metadata)}`,
      );
      lines.push(
        `- Total: ${formatTokenAmount(row.totals.total, row.metadata)}`,
      );
      lines.push(
        `- Skipped strategies: ${row.totals.skippedStrategies.toString()}${row.totals.skippedStrategies > 0n ? " (lower bound)" : ""}`,
      );
    }
  }
  lines.push("");

  lines.push("## Strategies");
  if (args.partialHistory) {
    lines.push(
      "Historical pair discovery is partial because the selected history start block is later than deployment.",
    );
    lines.push("");
  }
  if (args.strategyRows.length === 0) {
    lines.push("_No strategy pairs discovered in the selected history range._");
  } else {
    for (const row of args.strategyRows) {
      const tokenMetadata = await readTokenMetadataCached(
        args.publicClient,
        args.tokenMetadataCache,
        row.token,
        new Set(),
      );
      lines.push(
        `### ${row.displayName}${row.registryKey === undefined ? "" : ` (${row.registryKey})`}`,
      );
      lines.push(`- Strategy: \`${row.strategy}\``);
      lines.push(
        `- Vault token: ${tokenLabel(tokenMetadata)} (\`${row.token}\`)`,
      );
      lines.push(`- Lifecycle: ${row.lifecycle}`);
      lines.push(
        `- Config: whitelisted=${String(row.tokenConfig.whitelisted)}, active=${String(row.tokenConfig.active)}, cap=${row.tokenConfig.cap.toString()}`,
      );
      lines.push(
        `- Strategy exposure: ${formatNullableAmount(
          row.exposure,
          tokenMetadata,
        )}`,
      );
      lines.push(
        `- Strategy cost basis: ${formatNullableAmount(
          row.costBasis,
          tokenMetadata,
        )}`,
      );
      lines.push(
        `- Harvestable yield: ${formatNullableAmount(
          row.harvestableYield,
          tokenMetadata,
        )}`,
      );
      if (row.tvlTokens === null) {
        lines.push(`- TVL tokens: degraded`);
      } else if (row.tvlTokens.length === 0) {
        lines.push(`- TVL tokens: none`);
      } else {
        lines.push(
          `- TVL tokens: ${(
            await Promise.all(
              row.tvlTokens.map(async (token) =>
                tokenLabel(
                  await readTokenMetadataCached(
                    args.publicClient,
                    args.tokenMetadataCache,
                    token,
                    new Set(),
                  ),
                ),
              ),
            )
          ).join(", ")}`,
        );
      }

      if (row.vaultPositionBreakdown === null) {
        lines.push(`- Position breakdown: degraded`);
      } else if (row.vaultPositionBreakdown.length === 0) {
        lines.push(`- Position breakdown: none`);
      } else {
        lines.push(`- Position breakdown:`);
        for (const component of row.vaultPositionBreakdown) {
          const componentMetadata = await readTokenMetadataCached(
            args.publicClient,
            args.tokenMetadataCache,
            component.token,
            new Set(),
          );
          lines.push(
            `  - ${tokenLabel(componentMetadata)}: ${formatTokenAmount(component.amount, componentMetadata)} (kind=${String(component.kind)})`,
          );
        }
      }

      if (row.degradedSurfaces.length > 0) {
        lines.push(`- Degraded reads: ${row.degradedSurfaces.join(", ")}`);
      }
    }
  }
  lines.push("");

  const historyByCategory = new Map<EventCategory, HistoricalEvent[]>();
  for (const category of EVENT_CATEGORIES) {
    historyByCategory.set(category, []);
  }
  for (const event of args.history) {
    historyByCategory.get(eventCategory(event.eventName))!.push(event);
  }

  lines.push("## Significant Historical Events");
  for (const category of EVENT_CATEGORIES) {
    lines.push(`### ${category}`);
    const selected = historyByCategory
      .get(category)!
      .slice(0, args.maxEventsPerCategory);
    if (selected.length === 0) {
      lines.push("_No events._");
      continue;
    }
    for (const event of selected) {
      lines.push(
        `- Block ${event.blockNumber.toString()} | Tx \`${event.transactionHash}\` | ${await summarizeEvent(
          {
            event,
            publicClient: args.publicClient,
            tokenMetadataCache: args.tokenMetadataCache,
            vaultAbi: args.vaultAbi,
            vaultAddress: args.vaultAddress,
          },
        )}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Build a concise operator-facing summary line for one decoded event. */
async function summarizeEvent(args: {
  event: HistoricalEvent;
  publicClient: PublicClient;
  tokenMetadataCache: Map<string, Promise<TokenMetadata>>;
  vaultAbi: Abi;
  vaultAddress: Address;
}): Promise<string> {
  const { event } = args;
  const tokenArg =
    normalizeLoggedAddress(event.args.vaultToken) ??
    normalizeLoggedAddress(event.args.token);
  const strategyArg = normalizeLoggedAddress(event.args.strategy);
  const tokenLabelText =
    tokenArg === undefined
      ? undefined
      : tokenLabel(
          await readTokenMetadataCached(
            args.publicClient,
            args.tokenMetadataCache,
            tokenArg,
            new Set(),
          ),
        );

  switch (event.eventName) {
    case "VaultTokenConfigUpdated":
      return `VaultTokenConfigUpdated: ${tokenLabelText ?? "token"} support=${String((event.args.cfg as { supported: boolean }).supported)}`;
    case "VaultTokenStrategyConfigUpdated": {
      const currentAtBlock = await readHistoricalStrategyConfigAtBlock({
        blockNumber: event.blockNumber,
        publicClient: args.publicClient,
        strategy: strategyArg,
        token: tokenArg,
        vaultAbi: args.vaultAbi,
        vaultAddress: args.vaultAddress,
      });
      const cap = bigintArg(event.args.cap);
      if (currentAtBlock?.whitelisted && currentAtBlock.active) {
        return `VaultTokenStrategyConfigUpdated: ${tokenLabelText ?? "token"} -> ${strategyArg} whitelisted / activated (cap=${cap?.toString() ?? "?"})`;
      }
      if (currentAtBlock?.active && !currentAtBlock.whitelisted) {
        return `VaultTokenStrategyConfigUpdated: ${tokenLabelText ?? "token"} -> ${strategyArg} moved to withdraw-only (cap=${cap?.toString() ?? "?"})`;
      }
      if (currentAtBlock !== undefined && !currentAtBlock.active) {
        return `VaultTokenStrategyConfigUpdated: ${tokenLabelText ?? "token"} -> ${strategyArg} removed`;
      }
      return `VaultTokenStrategyConfigUpdated: ${tokenLabelText ?? "token"} -> ${strategyArg} updated (cap=${cap?.toString() ?? "?"})`;
    }
    case "VaultTokenAllocatedToStrategy":
      return `Allocated ${bigintArg(event.args.amount)?.toString() ?? "?"} of ${tokenLabelText ?? "token"} to ${strategyArg}`;
    case "VaultTokenAllocationSpentMismatch":
      return `Allocation spent mismatch on ${tokenLabelText ?? "token"} for ${strategyArg}: requested=${bigintArg(event.args.requested)?.toString() ?? "?"}, actual=${bigintArg(event.args.actualSpent)?.toString() ?? "?"}`;
    case "VaultTokenDeallocatedFromStrategy":
      return `Deallocated ${bigintArg(event.args.received)?.toString() ?? "?"} of ${tokenLabelText ?? "token"} from ${strategyArg}`;
    case "StrategyReportedReceivedMismatch":
      return `Strategy reported mismatch on ${tokenLabelText ?? "token"} for ${strategyArg}: reported=${bigintArg(event.args.reported)?.toString() ?? "?"}, actual=${bigintArg(event.args.actual)?.toString() ?? "?"}`;
    case "YieldHarvested":
      return `Harvested ${bigintArg(event.args.received)?.toString() ?? "?"} of ${tokenLabelText ?? "token"} from ${strategyArg} to ${normalizeLoggedAddress(event.args.yieldRecipient)}`;
    case "BridgeSentToL2": {
      const isNative = booleanArg(event.args.isNative);
      const kind = isNative ? "native" : "ERC20";
      return `BridgeSentToL2: ${kind} send of ${bigintArg(event.args.amount)?.toString() ?? "?"} ${tokenLabelText ?? "token"}`;
    }
    case "VaultPaused":
      return `Vault paused by ${normalizeLoggedAddress(event.args.account)}`;
    case "VaultUnpaused":
      return `Vault unpaused by ${normalizeLoggedAddress(event.args.account)}`;
    case "YieldRecipientTimelockControllerUpdated":
      return `Yield recipient timelock updated to ${normalizeLoggedAddress(event.args.newTimelock)}`;
    case "YieldRecipientUpdated":
      return `Yield recipient updated to ${normalizeLoggedAddress(event.args.newYieldRecipient)}`;
    case "NativeBridgeGatewayUpdated":
      return `Native bridge gateway updated to ${normalizeLoggedAddress(event.args.newNativeBridgeGateway)}`;
    case "TrackedTvlTokenOverrideUpdated":
      return `Tracked TVL token override updated for ${tokenLabelText ?? "token"}: enabled=${String(booleanArg(event.args.enabled))}, forceTrack=${String(booleanArg(event.args.forceTrack))}`;
    case "NativeSweptToYieldRecipient":
      return `Native swept to yield recipient ${normalizeLoggedAddress(event.args.yieldRecipient)} amount=${bigintArg(event.args.amount)?.toString() ?? "?"}`;
    case "StrategyRemovalCheckFailed":
      return `Strategy removal check failed for ${strategyArg} on ${tokenLabelText ?? "token"}`;
    default:
      return `${event.eventName}`;
  }
}

/** Read historical pair config at one block to distinguish withdraw-only from removed. */
async function readHistoricalStrategyConfigAtBlock(args: {
  blockNumber: bigint;
  publicClient: PublicClient;
  strategy?: Address;
  token?: Address;
  vaultAbi: Abi;
  vaultAddress: Address;
}): Promise<VaultTokenStrategyConfig | undefined> {
  if (args.strategy === undefined || args.token === undefined) {
    return undefined;
  }
  try {
    return (await args.publicClient.readContract({
      address: args.vaultAddress,
      abi: args.vaultAbi,
      functionName: "getVaultTokenStrategyConfig",
      args: [args.token, args.strategy],
      blockNumber: args.blockNumber,
    })) as VaultTokenStrategyConfig;
  } catch {
    return undefined;
  }
}

/** Format one token amount in native token units when decimals are known. */
function formatTokenAmount(value: bigint, metadata: TokenMetadata): string {
  if (metadata.decimals === undefined) {
    return `${value.toString()} raw`;
  }
  return `${trimFormattedUnits(formatUnits(value, metadata.decimals))} ${metadata.symbol ?? metadata.address}`;
}

/** Format an optional bigint amount while preserving null as a degraded marker. */
function formatNullableAmount(
  value: bigint | null,
  metadata: TokenMetadata,
): string {
  if (value === null) return "degraded";
  return formatTokenAmount(value, metadata);
}

/** Trim insignificant zeros from formatted decimal strings. */
function trimFormattedUnits(value: string): string {
  return value.replace(/\.?0+$/, "");
}

/** Build a compact human label for one token from its metadata. */
function tokenLabel(metadata: TokenMetadata): string {
  if (metadata.symbol !== undefined) {
    return `${metadata.symbol} (${metadata.address})`;
  }
  return `${metadata.address} (metadata unavailable)`;
}

/** Build a stable map from strategy proxy address to registry label metadata. */
function buildRegistryStrategyLookup(
  registry: DeploymentStateEnrichment | undefined,
): Map<string, { displayName: string; key: string }> {
  const lookup = new Map<string, { displayName: string; key: string }>();
  if (registry === undefined) return lookup;
  for (const [key, strategy] of Object.entries(registry.strategies ?? {})) {
    lookup.set(strategy.proxy.toLowerCase(), {
      displayName: strategy.displayName,
      key,
    });
  }
  return lookup;
}

/** Normalize one address-like event argument into a checksum address. */
function normalizeLoggedAddress(value: unknown): Address | undefined {
  if (typeof value !== "string" || !isAddress(value)) return undefined;
  return getAddress(value);
}

/** Read one bigint-like event argument. */
function bigintArg(value: unknown): bigint | undefined {
  return typeof value === "bigint" ? value : undefined;
}

/** Read one boolean-like event argument. */
function booleanArg(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Build a stable composite key for one `(vaultToken, strategy)` pair. */
function pairKey(vaultToken: Address, strategy: Address): string {
  return `${vaultToken.toLowerCase()}:${strategy.toLowerCase()}`;
}

/** Sort strategy pairs deterministically for report rendering. */
function comparePairs(left: StrategyPair, right: StrategyPair): number {
  const leftToken = left.vaultToken.toLowerCase();
  const rightToken = right.vaultToken.toLowerCase();
  if (leftToken !== rightToken) return leftToken.localeCompare(rightToken);
  return left.strategy
    .toLowerCase()
    .localeCompare(right.strategy.toLowerCase());
}
