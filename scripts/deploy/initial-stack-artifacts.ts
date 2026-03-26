import { join } from "node:path";

/**
 * Canonical run-artifact location for the interactive initial-stack flow.
 *
 * Each run stores its manifest, generated params, logs, and summary under:
 * `ignition/deployments/initial-stack/<environment>/<network>/<runId>/`
 */
export function initialStackArtifactsRoot(repoRoot: string): string {
  return join(repoRoot, "ignition", "deployments", "initial-stack");
}
