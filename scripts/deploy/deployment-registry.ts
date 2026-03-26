import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { Address } from "viem";

/**
 * Canonical deployment registry helpers.
 *
 * This module defines the checked-in "current live state" snapshot stored under
 * `deployments/<environment>/<network>.json`. The snapshot is intentionally
 * compact and operator-facing: it tracks the current vault, native bridge,
 * timelock, and strategy addresses plus the operation that most recently wrote
 * each component.
 *
 * The registry is not a replacement for raw Ignition output. Ignition
 * deployments, generated params, manifests, and logs remain the supporting
 * forensic record. This file only provides the stable schema and read/write
 * helpers used by deployment flows and post-deploy sync tools.
 */
export type DeploymentArtifactReference = {
  deploymentId?: string;
  deploymentIds?: string[];
  kind: "ignition-deployment" | "initial-stack-run";
  paramsFile?: string;
  path: string;
  runId?: string;
};

export type DeploymentOperationReference = {
  artifact: DeploymentArtifactReference;
  recordedAt: string;
  type:
    | "initial-stack"
    | "native-bridge-gateway-upgrade"
    | "strategy-added"
    | "strategy-upgrade"
    | "vault-upgrade";
};

export type DeploymentRegistryVault = {
  bridgeHub: Address;
  deployAdmin: Address;
  grvtBridgeProxyFeeToken: Address;
  implementation: Address;
  l2ChainId: string;
  l2ExchangeRecipient: Address;
  proxy: Address;
  proxyAdmin: Address;
  source: DeploymentOperationReference;
  wrappedNativeToken: Address;
  yieldRecipient: Address;
};

export type DeploymentRegistryNativeBridge = {
  implementation: Address;
  nativeVaultGateway: Address;
  proxy: Address;
  proxyAdmin: Address;
  proxyAdminOwner: Address;
  source: DeploymentOperationReference;
};

export type DeploymentRegistryYieldRecipientTimelock = {
  controller: Address;
  source: DeploymentOperationReference;
};

export type DeploymentRegistryStrategyStatus =
  | "active"
  | "deployed"
  | "inactive"
  | "withdraw_only";

export type DeploymentRegistryStrategy = {
  aToken: Address;
  aavePool: Address;
  configuredCap?: string;
  displayName: string;
  implementation: Address;
  key: string;
  proxy: Address;
  proxyAdmin?: Address;
  proxyAdminOwner: Address;
  source: DeploymentOperationReference;
  status: DeploymentRegistryStrategyStatus;
  type: "aave-v3";
  vaultToken: Address;
  vaultTokenStrategyWhitelisted?: boolean;
  vaultTokenSupported?: boolean;
};

export type DeploymentRegistrySnapshot = {
  environment: string;
  nativeBridge?: DeploymentRegistryNativeBridge;
  network: {
    chainId: number;
    name: string;
  };
  schemaVersion: 1;
  strategies: Record<string, DeploymentRegistryStrategy>;
  updatedAt: string;
  vault?: DeploymentRegistryVault;
  yieldRecipientTimelock?: DeploymentRegistryYieldRecipientTimelock;
};

/** Return the checked-in registry path for one environment/network pair. */
export function deploymentRegistryPath(
  repoRoot: string,
  environment: string,
  network: string,
): string {
  return join(repoRoot, "deployments", environment, `${network}.json`);
}

/**
 * Load an existing registry snapshot or create an empty one for a fresh
 * environment/network pair.
 *
 * Existing snapshots are validated against the requested environment, network,
 * and chain id so callers do not accidentally write one deployment into the
 * wrong registry file.
 */
export function readOrCreateDeploymentRegistry(args: {
  chainId: number;
  environment: string;
  network: string;
  repoRoot: string;
}): DeploymentRegistrySnapshot {
  const registryPath = deploymentRegistryPath(
    args.repoRoot,
    args.environment,
    args.network,
  );
  if (!existsSync(registryPath)) {
    return {
      environment: args.environment,
      network: {
        chainId: args.chainId,
        name: args.network,
      },
      schemaVersion: 1,
      strategies: {},
      updatedAt: new Date().toISOString(),
    };
  }

  const snapshot = JSON.parse(
    readFileSync(registryPath, "utf8"),
  ) as DeploymentRegistrySnapshot;
  if (snapshot.environment !== args.environment) {
    throw new Error(
      `registry environment mismatch: expected ${args.environment}, found ${snapshot.environment}`,
    );
  }
  if (snapshot.network.name !== args.network) {
    throw new Error(
      `registry network mismatch: expected ${args.network}, found ${snapshot.network.name}`,
    );
  }
  if (snapshot.network.chainId !== args.chainId) {
    throw new Error(
      `registry chainId mismatch: expected ${String(args.chainId)}, found ${String(snapshot.network.chainId)}`,
    );
  }
  return snapshot;
}

/**
 * Persist the current snapshot to its checked-in JSON path and refresh the
 * top-level `updatedAt` timestamp.
 */
export function writeDeploymentRegistry(
  repoRoot: string,
  snapshot: DeploymentRegistrySnapshot,
): string {
  const registryPath = deploymentRegistryPath(
    repoRoot,
    snapshot.environment,
    snapshot.network.name,
  );
  mkdirSync(dirname(registryPath), { recursive: true });
  snapshot.updatedAt = new Date().toISOString();
  writeFileSync(registryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return registryPath;
}

/** Convert an absolute registry path into a repo-relative path for CLI output. */
export function repoRelativeRegistryPath(
  repoRoot: string,
  filePath: string,
): string {
  return relative(repoRoot, filePath) || ".";
}

/** Insert or replace one strategy entry using its stable registry key. */
export function upsertDeploymentStrategy(
  snapshot: DeploymentRegistrySnapshot,
  strategy: DeploymentRegistryStrategy,
): void {
  snapshot.strategies[strategy.key] = strategy;
}
