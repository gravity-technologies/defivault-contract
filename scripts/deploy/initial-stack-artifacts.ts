import { join } from "node:path";
import { operationRecordsRoot } from "./operation-records.js";

/**
 * Canonical run-artifact location for the interactive initial-stack flow.
 *
 * Each run stores its canonical `record.json` and any failure logs under:
 * `deployment-records/<environment>/<runId>/`
 */
export function initialStackArtifactsRoot(repoRoot: string): string {
  return operationRecordsRoot(repoRoot);
}

export function initialStackRunDir(
  repoRoot: string,
  environment: string,
  runId: string,
): string {
  return join(initialStackArtifactsRoot(repoRoot), environment, runId);
}
