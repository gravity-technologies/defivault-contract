import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type OperationKind =
  | "initial-stack"
  | "vault-allocate-to-strategy"
  | "vault-deallocate-from-strategy"
  | "vault-deallocate-all-from-strategy"
  | "vault-harvest-yield"
  | "gho-claim-rewards"
  | "native-bridge-gateway-claim-failed-deposit"
  | "production-admin-handoff"
  | "yield-recipient-schedule-update"
  | "yield-recipient-execute-update"
  | "vault-upgrade"
  | "strategy-upgrade";

export type OperationMode = "confirm" | "direct" | "prepare";

export type OperationStatus =
  | "aborted"
  | "awaiting_confirmation"
  | "awaiting_handoff"
  | "complete"
  | "failed"
  | "prepared";

export type OperationActor = {
  longLivedAuthority?: string;
  signer: string;
};

export type OperationArtifact = {
  path: string;
  sha256?: string;
};

export type OperationLink = {
  kind: string;
  path?: string;
  recordId?: string;
};

export type OperationStep = {
  addresses?: Record<string, string>;
  artifacts?: OperationArtifact[];
  command?: string;
  completedAt?: string;
  deploymentId?: string;
  duration?: string;
  label: string;
  logFiles?: { stderr: string; stdout: string };
  nextAction?: string;
  notes?: string[];
  startedAt?: string;
  status: OperationStatus;
  txHashes?: string[];
};

export type OperationRecord = {
  actor: OperationActor;
  artifacts?: OperationArtifact[];
  chainId: number;
  checklist?: string[];
  createdAt: string;
  environment: string;
  inputs?: Record<string, unknown>;
  kind: OperationKind;
  links?: OperationLink[];
  mode: OperationMode;
  network: string;
  outputs?: Record<string, unknown>;
  recordId: string;
  schemaVersion: 1;
  status: OperationStatus;
  steps?: OperationStep[];
  summary?: string[];
};

export type CurrentDeploymentState = {
  chainId: number;
  cutoffRecordId?: string;
  cutoffRecordPath?: string;
  environment: string;
  initialStackRecordId: string;
  initialStackRecordPath: string;
  nativeBridge?: {
    implementation: string;
    proxy: string;
    proxyAdmin: string;
    proxyAdminOwner: string;
    nativeVaultGateway: string;
  };
  network: string;
  strategies: Record<
    string,
    {
      aToken: string;
      aavePool: string;
      displayName: string;
      implementation: string;
      key: string;
      proxy: string;
      proxyAdmin?: string;
      proxyAdminOwner: string;
      vaultToken: string;
    }
  >;
  vault?: {
    bridgeHub: string;
    deployAdmin: string;
    grvtBridgeProxyFeeToken: string;
    implementation: string;
    l2ChainId: string;
    l2ExchangeRecipient: string;
    proxy: string;
    proxyAdmin: string;
    wrappedNativeToken: string;
    yieldRecipient: string;
  };
  yieldRecipientTimelock?: {
    controller: string;
  };
};

export const OPERATION_RECORD_SCHEMA_VERSION = 1 as const;

export function operationRecordsRoot(repoRoot: string): string {
  return join(repoRoot, "deployment-records");
}

export function operationRecordDir(args: {
  environment: string;
  kind: OperationKind;
  network: string;
  recordId: string;
  repoRoot: string;
}): string {
  return join(
    operationRecordsRoot(args.repoRoot),
    args.environment,
    args.network,
    `${args.recordId}-${args.kind}`,
  );
}

export function ensureOperationRecordDir(recordDir: string): void {
  mkdirSync(recordDir, { recursive: true });
}

export function operationRecordPath(recordDir: string): string {
  return join(recordDir, "record.json");
}

export function writeOperationRecord(
  recordDir: string,
  record: OperationRecord,
): string {
  ensureOperationRecordDir(recordDir);
  const filePath = operationRecordPath(recordDir);
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}

export function readOperationRecord(recordDirOrPath: string): OperationRecord {
  const candidate = resolve(recordDirOrPath);
  const filePath =
    candidate.endsWith(".json") && existsSync(candidate)
      ? candidate
      : operationRecordPath(candidate);
  if (!existsSync(filePath)) {
    throw new Error(`operation record not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as OperationRecord;
}

export function repoRelativePath(repoRoot: string, filePath: string): string {
  return relative(repoRoot, filePath) || ".";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeRecordId(): string {
  return nowIso().replace(/[:.]/g, "-");
}

export function appendArtifacts(
  record: OperationRecord,
  ...artifacts: OperationArtifact[]
): OperationRecord {
  return {
    ...record,
    artifacts: [...(record.artifacts ?? []), ...artifacts],
  };
}

export function updateOperationSummary(
  record: OperationRecord,
  summary: string[],
): OperationRecord {
  return {
    ...record,
    summary,
  };
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function operationSortKey(record: OperationRecord): string {
  return `${record.createdAt}|${record.recordId}`;
}

function compareOperationRecords(
  left: OperationRecord,
  right: OperationRecord,
): number {
  return operationSortKey(left).localeCompare(operationSortKey(right));
}

export function listOperationRecords(args: {
  environment: string;
  kind?: OperationKind;
  network: string;
  repoRoot: string;
  status?: OperationStatus;
}): Array<{ record: OperationRecord; recordDir: string; recordPath: string }> {
  const networkDir = join(
    operationRecordsRoot(args.repoRoot),
    args.environment,
    args.network,
  );
  if (!existsSync(networkDir)) {
    return [];
  }

  return readdirSync(networkDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const recordDir = join(networkDir, entry.name);
      const recordPath = operationRecordPath(recordDir);
      if (!existsSync(recordPath)) {
        return undefined;
      }
      const record = readOperationRecord(recordPath);
      if (args.kind !== undefined && record.kind !== args.kind) {
        return undefined;
      }
      if (args.status !== undefined && record.status !== args.status) {
        return undefined;
      }
      return { record, recordDir, recordPath };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        record: OperationRecord;
        recordDir: string;
        recordPath: string;
      } => candidate !== undefined,
    )
    .sort((left, right) => compareOperationRecords(left.record, right.record));
}

function extractResolvedInputs(record: OperationRecord): Record<string, any> {
  const inputs = record.inputs;
  if (typeof inputs !== "object" || inputs === null) {
    throw new Error(`operation record ${record.recordId} is missing inputs`);
  }
  const nested = (inputs as Record<string, unknown>).resolvedParams;
  if (typeof nested === "object" && nested !== null) {
    return nested as Record<string, any>;
  }
  return inputs as Record<string, any>;
}

function extractStrategyKey(record: OperationRecord): string {
  const inputs = record.inputs;
  if (typeof inputs !== "object" || inputs === null) {
    return "primary";
  }
  const value = (inputs as Record<string, unknown>).strategyKey;
  return typeof value === "string" && value.length > 0 ? value : "primary";
}

export function resolveCurrentDeploymentState(args: {
  environment?: string;
  network?: string;
  recordPathOrDir?: string;
  repoRoot: string;
}): CurrentDeploymentState {
  const targetRecord =
    args.recordPathOrDir === undefined
      ? undefined
      : readOperationRecord(args.recordPathOrDir);
  const environment = targetRecord?.environment ?? args.environment;
  const network = targetRecord?.network ?? args.network;
  if (environment === undefined || network === undefined) {
    throw new Error(
      "resolveCurrentDeploymentState requires either --record or both environment and network",
    );
  }

  const records = listOperationRecords({
    environment,
    network,
    repoRoot: args.repoRoot,
  });
  const cutoffKey =
    targetRecord === undefined ? undefined : operationSortKey(targetRecord);
  const boundedRecords =
    cutoffKey === undefined
      ? records
      : records.filter(
          ({ record }) =>
            operationSortKey(record).localeCompare(cutoffKey) <= 0,
        );

  const explicitInitialStack =
    targetRecord?.kind === "initial-stack"
      ? boundedRecords.find(
          ({ record }) => record.recordId === targetRecord.recordId,
        )
      : undefined;
  const baseRecord =
    explicitInitialStack ??
    [...boundedRecords]
      .reverse()
      .find(
        ({ record }) =>
          record.kind === "initial-stack" &&
          (record.status === "complete" ||
            (targetRecord?.kind === "initial-stack" &&
              record.recordId === targetRecord.recordId)),
      );

  if (baseRecord === undefined) {
    throw new Error(
      `no initial-stack record found for ${environment}/${network}`,
    );
  }

  const baseInputs = extractResolvedInputs(baseRecord.record);
  const baseOutputs = (baseRecord.record.outputs ?? {}) as Record<string, any>;
  if (
    typeof baseOutputs.vaultProxy !== "string" ||
    typeof baseOutputs.strategyProxy !== "string"
  ) {
    throw new Error(
      `initial-stack record ${baseRecord.record.recordId} is missing core deployment outputs`,
    );
  }

  const state: CurrentDeploymentState = {
    chainId: baseRecord.record.chainId,
    cutoffRecordId: targetRecord?.recordId,
    cutoffRecordPath:
      targetRecord === undefined
        ? undefined
        : repoRelativePath(
            args.repoRoot,
            args.recordPathOrDir?.endsWith(".json")
              ? resolve(args.recordPathOrDir)
              : operationRecordPath(resolve(args.recordPathOrDir!)),
          ),
    environment,
    initialStackRecordId: baseRecord.record.recordId,
    initialStackRecordPath: repoRelativePath(
      args.repoRoot,
      baseRecord.recordPath,
    ),
    nativeBridge:
      typeof baseOutputs.nativeBridgeGatewayProxy === "string"
        ? {
            implementation: String(
              baseOutputs.nativeBridgeGatewayImplementation,
            ),
            nativeVaultGateway: String(baseOutputs.nativeVaultGateway),
            proxy: String(baseOutputs.nativeBridgeGatewayProxy),
            proxyAdmin: String(baseOutputs.nativeBridgeGatewayProxyAdmin),
            proxyAdminOwner: String(baseInputs.nativeGateways.proxyAdminOwner),
          }
        : undefined,
    network,
    strategies: {
      primary: {
        aToken: String(baseInputs.strategyCore.aToken),
        aavePool: String(baseInputs.strategyCore.aavePool),
        displayName: String(baseInputs.strategyCore.strategyName),
        implementation: String(baseOutputs.strategyImplementation),
        key: "primary",
        proxy: String(baseOutputs.strategyProxy),
        proxyAdmin:
          typeof baseOutputs.strategyProxyAdmin === "string"
            ? String(baseOutputs.strategyProxyAdmin)
            : undefined,
        proxyAdminOwner: String(baseInputs.strategyCore.proxyAdminOwner),
        vaultToken: String(baseInputs.strategyCore.underlyingToken),
      },
    },
    vault:
      typeof baseOutputs.vaultProxy === "string"
        ? {
            bridgeHub: String(baseInputs.vaultCore.bridgeHub),
            deployAdmin: String(baseInputs.vaultCore.deployAdmin),
            grvtBridgeProxyFeeToken: String(
              baseInputs.vaultCore.grvtBridgeProxyFeeToken,
            ),
            implementation: String(baseOutputs.vaultImplementation),
            l2ChainId: String(baseInputs.vaultCore.l2ChainId),
            l2ExchangeRecipient: String(
              baseInputs.vaultCore.l2ExchangeRecipient,
            ),
            proxy: String(baseOutputs.vaultProxy),
            proxyAdmin: String(baseOutputs.vaultProxyAdmin),
            wrappedNativeToken: String(baseInputs.vaultCore.wrappedNativeToken),
            yieldRecipient: String(baseInputs.vaultCore.yieldRecipient),
          }
        : undefined,
    yieldRecipientTimelock:
      typeof baseOutputs.yieldRecipientTimelockController === "string"
        ? {
            controller: String(baseOutputs.yieldRecipientTimelockController),
          }
        : undefined,
  };

  const handoff = [...boundedRecords]
    .reverse()
    .find(
      ({ record }) =>
        record.kind === "production-admin-handoff" &&
        record.status === "complete",
    );
  if (
    handoff !== undefined &&
    state.vault !== undefined &&
    typeof baseInputs.productionAuthorityPlan?.finalVaultAdmin === "string"
  ) {
    state.vault.deployAdmin = String(
      baseInputs.productionAuthorityPlan.finalVaultAdmin,
    );
  }

  for (const { record } of boundedRecords) {
    if (record.status !== "complete") continue;
    if (record.kind === "vault-upgrade" && state.vault !== undefined) {
      const outputs = (record.outputs ?? {}) as Record<string, unknown>;
      if (String(outputs.proxy) === state.vault.proxy) {
        state.vault.implementation = String(outputs.implementation);
      }
      continue;
    }
    if (record.kind === "strategy-upgrade") {
      const outputs = (record.outputs ?? {}) as Record<string, unknown>;
      const strategyKey = extractStrategyKey(record);
      const strategy = state.strategies[strategyKey];
      if (strategy !== undefined && String(outputs.proxy) === strategy.proxy) {
        strategy.implementation = String(outputs.implementation);
      }
    }
  }

  return state;
}
