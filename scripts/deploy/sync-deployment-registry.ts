import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import JSON5 from "json5";
import {
  getAddress,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  readOrCreateDeploymentRegistry,
  repoRelativeRegistryPath,
  type DeploymentOperationReference,
  type DeploymentRegistrySnapshot,
  upsertDeploymentStrategy,
  writeDeploymentRegistry,
} from "./deployment-registry.js";

/**
 * Deployment-registry sync CLI.
 *
 * This script updates the checked-in current snapshot at
 * `deployments/<environment>/<network>.json` after concrete deployment
 * operations have already succeeded. It does not deploy contracts and it does
 * not reconstruct full historical state; instead it projects the latest known
 * live addresses from one initial-stack run or one Ignition deployment into the
 * canonical registry file.
 *
 * Supported flows:
 * - backfill an initial-stack run into the registry
 * - update the vault implementation after a vault upgrade
 * - update a strategy implementation after a strategy upgrade
 * - update the native bridge gateway implementation after its upgrade
 * - add or refresh a strategy entry after a new strategy-core deployment
 *
 * The guardrails here are deliberate: the script cross-checks proxies already
 * present in the registry against the supplied parameter files so an operator
 * does not accidentally point the wrong deployment at the wrong environment.
 */
type Operation =
  | "initial-stack"
  | "native-bridge-gateway-upgrade"
  | "strategy-core"
  | "strategy-upgrade"
  | "vault-upgrade";

type InitialStackManifest = {
  environment: {
    grvtEnv: string;
  };
  network: {
    alias: string;
    chainId: number;
  };
  resolvedParams: Record<string, any>;
  runId: string;
  steps: {
    addresses?: Record<string, string>;
    command?: string;
    name: string;
  }[];
};

const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;
const REPO_ROOT = process.cwd();

/** Throw a consistent fatal error for invalid CLI input or missing artifacts. */
function fail(message: string): never {
  throw new Error(message);
}

/** Read one raw CLI flag value directly from `process.argv`. */
function cliArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

/** Resolve the Hardhat network name used for onchain lookups in sync flows. */
function runtimeNetworkName(): string {
  return cliArgValue("--network") ?? "sepolia";
}

/** Normalize common Hardhat aliases into the registry network names we persist. */
function networkDisplayName(networkName: string, chainId?: number): string {
  if (networkName === "localhost") return "localhost";
  if (chainId === 1 || networkName === "mainnet") return "mainnet";
  if (chainId === 11155111 || networkName === "sepolia") return "sepolia";
  return networkName;
}

/** Validate and checksum-normalize an address before it enters the registry. */
function normalizeAddress(value: string): Address {
  if (!isAddress(value)) {
    fail(`invalid address: ${value}`);
  }
  return getAddress(value);
}

/** Parse the operation name plus `--flag value` options for the sync CLI. */
function parseArgs(argv: string[]): {
  options: Map<string, string | boolean>;
  operation: Operation;
} {
  const [operationArg, ...rest] = argv;
  if (
    operationArg !== "initial-stack" &&
    operationArg !== "vault-upgrade" &&
    operationArg !== "strategy-upgrade" &&
    operationArg !== "native-bridge-gateway-upgrade" &&
    operationArg !== "strategy-core"
  ) {
    fail(
      "usage: <initial-stack|vault-upgrade|strategy-upgrade|native-bridge-gateway-upgrade|strategy-core> [options]",
    );
  }

  const options = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      fail(`unexpected argument: ${arg}`);
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options.set(arg, true);
      continue;
    }
    options.set(arg, next);
    index += 1;
  }

  return {
    operation: operationArg,
    options,
  };
}

/** Require one string-valued option from the parsed CLI map. */
function requireOption(
  options: Map<string, string | boolean>,
  flag: string,
): string {
  const value = options.get(flag);
  if (typeof value !== "string") {
    fail(`missing value for ${flag}`);
  }
  return value;
}

/** Parse an optional boolean flag that may be passed as `true` or `false`. */
function optionalBooleanOption(
  options: Map<string, string | boolean>,
  flag: string,
): boolean | undefined {
  const value = options.get(flag);
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`${flag} must be true or false`);
}

/** Read an optional string flag from the parsed CLI map. */
function optionalStringOption(
  options: Map<string, string | boolean>,
  flag: string,
): string | undefined {
  const value = options.get(flag);
  return typeof value === "string" ? value : undefined;
}

/** Extract a deployment id from the command text recorded in an initial-stack manifest step. */
function extractDeploymentId(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const match = command.match(/(?:^|\s)--deployment-id\s+([^\s]+)/);
  return match?.[1];
}

/** Read the address map recorded for one named step in an initial-stack manifest. */
function stepAddresses(
  manifest: InitialStackManifest,
  stepName: string,
): Record<string, string> {
  const step = manifest.steps.find((candidate) => candidate.name === stepName);
  if (step?.addresses === undefined) {
    fail(`missing recorded addresses for ${stepName}`);
  }
  return step.addresses;
}

/** Load the saved initial-stack manifest from one run directory. */
function readManifest(runDir: string): InitialStackManifest {
  const manifestPath = join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`manifest not found: ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as InitialStackManifest;
}

/** Load one named module object from a JSON5 Ignition parameter file. */
function readJson5ModuleObject(
  filePath: string,
  key: string,
): Record<string, unknown> {
  if (!existsSync(filePath)) {
    fail(`parameters file not found: ${filePath}`);
  }
  const parsed = JSON5.parse(readFileSync(filePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`invalid JSON5 object in ${filePath}`);
  }
  const root = parsed as Record<string, unknown>;
  const value = root[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`missing ${key} object in ${filePath}`);
  }
  return value as Record<string, unknown>;
}

/** Read Ignition's `deployed_addresses.json` for one finished deployment id. */
function readIgnitionDeployedAddresses(
  deploymentId: string,
): Record<string, string> {
  const deployedAddressesPath = join(
    REPO_ROOT,
    "ignition",
    "deployments",
    deploymentId,
    "deployed_addresses.json",
  );
  if (!existsSync(deployedAddressesPath)) {
    fail(`deployed_addresses.json not found for ${deploymentId}`);
  }
  return JSON.parse(readFileSync(deployedAddressesPath, "utf8")) as Record<
    string,
    string
  >;
}

/** Read the EIP-1967 admin slot from a proxy to recover its ProxyAdmin address. */
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
  if (raw === undefined) fail("missing proxy admin slot value");
  const hex = raw.slice(2);
  return getAddress(`0x${hex.slice(24)}` as Address);
}

/** Build the operation metadata that is stored alongside the current snapshot state. */
function buildOperationSource(args: {
  deploymentId?: string;
  paramsFile?: string;
  path: string;
  recordedAt?: string;
  runId?: string;
  type: DeploymentOperationReference["type"];
}): DeploymentOperationReference {
  return {
    artifact: {
      deploymentId: args.deploymentId,
      kind:
        args.type === "initial-stack"
          ? "initial-stack-run"
          : "ignition-deployment",
      paramsFile: args.paramsFile,
      path: args.path,
      runId: args.runId,
    },
    recordedAt: args.recordedAt ?? new Date().toISOString(),
    type: args.type,
  };
}

/** Ensure the registry already knows about the vault before applying a vault-only mutation. */
function assertSnapshotHasVault(snapshot: DeploymentRegistrySnapshot): void {
  if (snapshot.vault === undefined) {
    fail("deployment registry does not yet contain vault state");
  }
}

/** Ensure the registry already knows about the native bridge before mutating it. */
function assertSnapshotHasNativeBridge(
  snapshot: DeploymentRegistrySnapshot,
): void {
  if (snapshot.nativeBridge === undefined) {
    fail("deployment registry does not yet contain native bridge state");
  }
}

/** Ensure the requested strategy key already exists before applying an upgrade mutation. */
function assertSnapshotHasStrategy(
  snapshot: DeploymentRegistrySnapshot,
  strategyKey: string,
): void {
  if (snapshot.strategies[strategyKey] === undefined) {
    fail(`deployment registry does not contain strategy key ${strategyKey}`);
  }
}

/**
 * Backfill or refresh the registry from one saved initial-stack run directory.
 *
 * This is the path that projects a full interactive deployment run into the
 * canonical snapshot, including the vault, primary strategy, timelock, and
 * native bridge surfaces.
 */
function syncInitialStack(args: { runDir: string }): string {
  const runDir = resolve(REPO_ROOT, args.runDir);
  const manifest = readManifest(runDir);
  const snapshot = readOrCreateDeploymentRegistry({
    chainId: manifest.network.chainId,
    environment: manifest.environment.grvtEnv,
    network: manifest.network.alias,
    repoRoot: REPO_ROOT,
  });
  const deploymentIds = manifest.steps
    .map((step) => extractDeploymentId(step.command))
    .filter((value): value is string => value !== undefined);
  const source = {
    artifact: {
      deploymentIds,
      kind: "initial-stack-run",
      path: relative(REPO_ROOT, runDir),
      runId: manifest.runId,
    },
    recordedAt: new Date().toISOString(),
    type: "initial-stack",
  } satisfies DeploymentOperationReference;
  const vaultCoreAddresses = stepAddresses(manifest, "Vault core deployment");
  const strategyCoreAddresses = stepAddresses(
    manifest,
    "Strategy core deployment",
  );
  const timelockAddresses = stepAddresses(
    manifest,
    "Yield recipient timelock bootstrap",
  );
  const nativeGatewayAddresses = stepAddresses(
    manifest,
    "Native gateways deployment",
  );

  snapshot.vault = {
    bridgeHub: manifest.resolvedParams.vaultCore.bridgeHub as Address,
    deployAdmin: manifest.resolvedParams.vaultCore.deployAdmin as Address,
    grvtBridgeProxyFeeToken: manifest.resolvedParams.vaultCore
      .grvtBridgeProxyFeeToken as Address,
    implementation: vaultCoreAddresses.vaultImplementation as Address,
    l2ChainId: manifest.resolvedParams.vaultCore.l2ChainId as string,
    l2ExchangeRecipient: manifest.resolvedParams.vaultCore
      .l2ExchangeRecipient as Address,
    proxy: vaultCoreAddresses.vaultProxy as Address,
    proxyAdmin: vaultCoreAddresses.vaultProxyAdmin as Address,
    source,
    wrappedNativeToken: manifest.resolvedParams.vaultCore
      .wrappedNativeToken as Address,
    yieldRecipient: manifest.resolvedParams.vaultCore.yieldRecipient as Address,
  };
  snapshot.yieldRecipientTimelock = {
    controller: timelockAddresses.yieldRecipientTimelockController as Address,
    source,
  };
  snapshot.nativeBridge = {
    implementation:
      nativeGatewayAddresses.nativeBridgeGatewayImplementation as Address,
    nativeVaultGateway: nativeGatewayAddresses.nativeVaultGateway as Address,
    proxy: nativeGatewayAddresses.nativeBridgeGatewayProxy as Address,
    proxyAdmin: nativeGatewayAddresses.nativeBridgeGatewayProxyAdmin as Address,
    proxyAdminOwner: manifest.resolvedParams.nativeGateways
      .proxyAdminOwner as Address,
    source,
  };
  upsertDeploymentStrategy(snapshot, {
    aToken: manifest.resolvedParams.strategyCore.aToken as Address,
    aavePool: manifest.resolvedParams.strategyCore.aavePool as Address,
    configuredCap: manifest.resolvedParams.vaultTokenStrategy
      .strategyCap as string,
    displayName: manifest.resolvedParams.strategyCore.strategyName as string,
    implementation: strategyCoreAddresses.strategyImplementation as Address,
    key: "primary",
    proxy: strategyCoreAddresses.strategyProxy as Address,
    proxyAdmin: strategyCoreAddresses.strategyProxyAdmin as Address,
    proxyAdminOwner: manifest.resolvedParams.strategyCore
      .proxyAdminOwner as Address,
    source,
    status:
      manifest.resolvedParams.vaultTokenStrategy
        .vaultTokenStrategyWhitelisted === true
        ? "active"
        : "deployed",
    type: "aave-v3",
    vaultToken: manifest.resolvedParams.strategyCore.underlyingToken as Address,
    vaultTokenStrategyWhitelisted: manifest.resolvedParams.vaultTokenStrategy
      .vaultTokenStrategyWhitelisted as boolean,
    vaultTokenSupported: manifest.resolvedParams.vaultTokenStrategy
      .vaultTokenSupported as boolean,
  });

  return writeDeploymentRegistry(REPO_ROOT, snapshot);
}

/** Update the tracked vault implementation after a successful vault upgrade deployment. */
async function syncVaultUpgrade(args: {
  chainId: number;
  currentNetwork: string;
  deploymentId: string;
  grvtEnvironment: string;
  paramsPath: string;
}): Promise<string> {
  const displayNetwork = networkDisplayName(args.currentNetwork, args.chainId);
  const snapshot = readOrCreateDeploymentRegistry({
    chainId: args.chainId,
    environment: args.grvtEnvironment,
    network: displayNetwork,
    repoRoot: REPO_ROOT,
  });
  assertSnapshotHasVault(snapshot);
  const params = readJson5ModuleObject(args.paramsPath, "VaultUpgradeModule");
  const vaultProxy = normalizeAddress(String(params.vaultProxy));
  if (
    snapshot.vault?.proxy !== undefined &&
    snapshot.vault.proxy !== vaultProxy
  ) {
    fail("vault upgrade parameters do not match the tracked vault proxy");
  }
  const deployed = readIgnitionDeployedAddresses(args.deploymentId);
  const source = buildOperationSource({
    deploymentId: args.deploymentId,
    paramsFile: relative(REPO_ROOT, args.paramsPath),
    path: join("ignition", "deployments", args.deploymentId),
    type: "vault-upgrade",
  });

  snapshot.vault = {
    ...snapshot.vault!,
    implementation: normalizeAddress(
      deployed["VaultUpgradeModule#VaultImplementationVNext"],
    ),
    source,
  };
  return writeDeploymentRegistry(REPO_ROOT, snapshot);
}

/** Update one tracked strategy implementation after a successful strategy upgrade deployment. */
async function syncStrategyUpgrade(args: {
  chainId: number;
  currentNetwork: string;
  deploymentId: string;
  grvtEnvironment: string;
  paramsPath: string;
  strategyKey: string;
}): Promise<string> {
  const displayNetwork = networkDisplayName(args.currentNetwork, args.chainId);
  const snapshot = readOrCreateDeploymentRegistry({
    chainId: args.chainId,
    environment: args.grvtEnvironment,
    network: displayNetwork,
    repoRoot: REPO_ROOT,
  });
  assertSnapshotHasStrategy(snapshot, args.strategyKey);
  const params = readJson5ModuleObject(
    args.paramsPath,
    "StrategyUpgradeModule",
  );
  const strategyProxy = normalizeAddress(String(params.strategyProxy));
  if (snapshot.strategies[args.strategyKey].proxy !== strategyProxy) {
    fail("strategy upgrade parameters do not match the tracked strategy proxy");
  }
  const deployed = readIgnitionDeployedAddresses(args.deploymentId);
  const source = buildOperationSource({
    deploymentId: args.deploymentId,
    paramsFile: relative(REPO_ROOT, args.paramsPath),
    path: join("ignition", "deployments", args.deploymentId),
    type: "strategy-upgrade",
  });

  snapshot.strategies[args.strategyKey] = {
    ...snapshot.strategies[args.strategyKey],
    implementation: normalizeAddress(
      deployed["StrategyUpgradeModule#StrategyImplementationVNext"],
    ),
    source,
  };
  return writeDeploymentRegistry(REPO_ROOT, snapshot);
}

/** Update the tracked native bridge gateway implementation after its upgrade deployment. */
async function syncNativeBridgeGatewayUpgrade(args: {
  chainId: number;
  currentNetwork: string;
  deploymentId: string;
  grvtEnvironment: string;
  paramsPath: string;
}): Promise<string> {
  const displayNetwork = networkDisplayName(args.currentNetwork, args.chainId);
  const snapshot = readOrCreateDeploymentRegistry({
    chainId: args.chainId,
    environment: args.grvtEnvironment,
    network: displayNetwork,
    repoRoot: REPO_ROOT,
  });
  assertSnapshotHasNativeBridge(snapshot);
  const params = readJson5ModuleObject(
    args.paramsPath,
    "NativeBridgeGatewayUpgradeModule",
  );
  const proxy = normalizeAddress(String(params.nativeBridgeGatewayProxy));
  if (snapshot.nativeBridge!.proxy !== proxy) {
    fail(
      "native bridge gateway upgrade parameters do not match the tracked proxy",
    );
  }
  const deployed = readIgnitionDeployedAddresses(args.deploymentId);
  const source = buildOperationSource({
    deploymentId: args.deploymentId,
    paramsFile: relative(REPO_ROOT, args.paramsPath),
    path: join("ignition", "deployments", args.deploymentId),
    type: "native-bridge-gateway-upgrade",
  });

  snapshot.nativeBridge = {
    ...snapshot.nativeBridge!,
    implementation: normalizeAddress(
      deployed[
        "NativeBridgeGatewayUpgradeModule#NativeBridgeGatewayImplementationVNext"
      ],
    ),
    source,
  };
  return writeDeploymentRegistry(REPO_ROOT, snapshot);
}

/**
 * Add a new strategy entry or refresh an existing one from a strategy-core
 * deployment plus optional registry-only status metadata.
 */
async function syncStrategyCore(args: {
  chainId: number;
  currentNetwork: string;
  deploymentId: string;
  grvtEnvironment: string;
  paramsPath: string;
  publicClient: PublicClient;
  strategyCap?: string;
  strategyKey: string;
  status?: string;
  vaultTokenStrategyWhitelisted?: boolean;
  vaultTokenSupported?: boolean;
}): Promise<string> {
  const displayNetwork = networkDisplayName(args.currentNetwork, args.chainId);
  const snapshot = readOrCreateDeploymentRegistry({
    chainId: args.chainId,
    environment: args.grvtEnvironment,
    network: displayNetwork,
    repoRoot: REPO_ROOT,
  });
  const params = readJson5ModuleObject(args.paramsPath, "StrategyCoreModule");
  const deployed = readIgnitionDeployedAddresses(args.deploymentId);
  const strategyProxy = normalizeAddress(
    deployed["StrategyCoreModule#StrategyProxy"],
  );
  const proxyAdmin = await readProxyAdminAddress(
    args.publicClient,
    strategyProxy,
  );
  if (
    snapshot.strategies[args.strategyKey] !== undefined &&
    snapshot.strategies[args.strategyKey].proxy !== strategyProxy
  ) {
    fail(
      `strategy key ${args.strategyKey} already exists with a different proxy`,
    );
  }
  const source = buildOperationSource({
    deploymentId: args.deploymentId,
    paramsFile: relative(REPO_ROOT, args.paramsPath),
    path: join("ignition", "deployments", args.deploymentId),
    type: "strategy-added",
  });

  upsertDeploymentStrategy(snapshot, {
    aToken: normalizeAddress(String(params.aToken)),
    aavePool: normalizeAddress(String(params.aavePool)),
    configuredCap: args.strategyCap,
    displayName: String(params.strategyName),
    implementation: normalizeAddress(
      deployed["StrategyCoreModule#StrategyImplementation"],
    ),
    key: args.strategyKey,
    proxy: strategyProxy,
    proxyAdmin,
    proxyAdminOwner: normalizeAddress(String(params.proxyAdminOwner)),
    source,
    status:
      args.status === "active" ||
      args.status === "withdraw_only" ||
      args.status === "inactive" ||
      args.status === "deployed"
        ? args.status
        : args.vaultTokenStrategyWhitelisted === true
          ? "active"
          : "deployed",
    type: "aave-v3",
    vaultToken: normalizeAddress(String(params.underlyingToken)),
    vaultTokenStrategyWhitelisted: args.vaultTokenStrategyWhitelisted,
    vaultTokenSupported: args.vaultTokenSupported,
  });
  return writeDeploymentRegistry(REPO_ROOT, snapshot);
}

/** Dispatch one sync operation from CLI input and print the updated registry path. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const separatorIndex = argv.indexOf("--");
  const relevantArgs =
    separatorIndex === -1 ? argv : argv.slice(separatorIndex + 1);
  const { operation, options } = parseArgs(relevantArgs);

  if (operation === "initial-stack") {
    const registryPath = syncInitialStack({
      runDir: requireOption(options, "--run-dir"),
    });
    console.log(repoRelativeRegistryPath(REPO_ROOT, registryPath));
    return;
  }

  const currentNetwork = runtimeNetworkName();
  const { network } = await import("hardhat");
  const { viem } = await network.connect(currentNetwork);
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const grvtEnvironment = requireOption(options, "--grvt-env");
  const deploymentId = requireOption(options, "--deployment-id");
  const paramsPath = resolve(REPO_ROOT, requireOption(options, "--parameters"));

  let registryPath: string;
  switch (operation) {
    case "vault-upgrade":
      registryPath = await syncVaultUpgrade({
        chainId,
        currentNetwork,
        deploymentId,
        grvtEnvironment,
        paramsPath,
      });
      break;
    case "strategy-upgrade":
      registryPath = await syncStrategyUpgrade({
        chainId,
        currentNetwork,
        deploymentId,
        grvtEnvironment,
        paramsPath,
        strategyKey: requireOption(options, "--strategy-key"),
      });
      break;
    case "native-bridge-gateway-upgrade":
      registryPath = await syncNativeBridgeGatewayUpgrade({
        chainId,
        currentNetwork,
        deploymentId,
        grvtEnvironment,
        paramsPath,
      });
      break;
    case "strategy-core":
      registryPath = await syncStrategyCore({
        chainId,
        currentNetwork,
        deploymentId,
        grvtEnvironment,
        paramsPath,
        publicClient,
        status: optionalStringOption(options, "--status"),
        strategyCap: optionalStringOption(options, "--strategy-cap"),
        strategyKey: requireOption(options, "--strategy-key"),
        vaultTokenStrategyWhitelisted: optionalBooleanOption(
          options,
          "--vault-token-strategy-whitelisted",
        ),
        vaultTokenSupported: optionalBooleanOption(
          options,
          "--vault-token-supported",
        ),
      });
      break;
    default:
      fail(`unsupported operation: ${String(operation)}`);
  }

  console.log(repoRelativeRegistryPath(REPO_ROOT, registryPath));
}

await main();
