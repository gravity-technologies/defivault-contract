#!/usr/bin/env node

import "dotenv/config";

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi, type Address } from "viem";

type Manifest = {
  network?: { name?: string };
  resolvedParams?: Record<string, unknown>;
};

type Artifact = {
  contractName?: string;
  sourceName?: string;
};

type VerificationTarget = {
  address: string;
  contract: string;
  constructorArgs: unknown[];
  label: string;
  slug: string;
};

type LoadedVerificationTargets = {
  network: string;
  targets: VerificationTarget[];
};

const AAVE_V2_INITIALIZE_ABI = parseAbi([
  "function initialize(address vault,address aavePool,address vaultToken,address aToken,string strategyName)",
]);

const GHO_STRATEGY_INITIALIZE_ABI = parseAbi([
  "function initialize(address vault,address stkGho,address gsm,address stkGhoRewardsDistributor,string strategyName)",
]);

export function fail(message: string): never {
  throw new Error(message);
}

export function parseArgs(argv: string[]) {
  let deploymentDir: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === "--deployment-dir") {
      const next = argv[++i];
      if (next === undefined) fail("missing value for --deployment-dir");
      deploymentDir = resolve(process.cwd(), next);
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (deploymentDir === undefined) {
    fail("missing required --deployment-dir <path>");
  }

  return { deploymentDir, force };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeDefaultExportModule(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `export default ${JSON.stringify(value, null, 2)};\n`,
  );
}

function findArtifact(
  artifactsDir: string,
  suffix: string,
): { artifact: Artifact; path: string } | null {
  const entries = readdirSync(artifactsDir, {
    withFileTypes: true,
  }) as Array<{ isFile(): boolean; name: string }>;
  const entry = entries.find(
    (candidate) => candidate.isFile() && candidate.name.endsWith(suffix),
  );
  if (entry === undefined) return null;

  const path = join(artifactsDir, entry.name);
  return { artifact: readJson<Artifact>(path), path };
}

export function targetForFamily(
  deploymentDir: string,
  manifest: Manifest,
  deployedAddresses: Record<string, string>,
): VerificationTarget[] {
  const artifactsDir = join(deploymentDir, "artifacts");
  const aaveImplementationArtifact = findArtifact(
    artifactsDir,
    "#StrategyV2Implementation.json",
  );
  const ghoImplementationArtifact = findArtifact(
    artifactsDir,
    "#GhoStrategyImplementation.json",
  );
  if (
    aaveImplementationArtifact !== null &&
    ghoImplementationArtifact !== null
  ) {
    fail(
      "ambiguous V2 family deployment: found both Aave and GHO implementation artifacts",
    );
  }

  if (aaveImplementationArtifact !== null) {
    if (
      aaveImplementationArtifact.artifact.contractName !== "AaveV3StrategyV2"
    ) {
      fail("unexpected Aave V2 family artifact contract");
    }
    const resolved = manifest.resolvedParams?.StrategyV2FamilyModule as
      | { beaconOwner?: string }
      | undefined;
    const implementation =
      deployedAddresses["StrategyV2FamilyModule#StrategyV2Implementation"];
    const beacon = deployedAddresses["StrategyV2FamilyModule#StrategyV2Beacon"];
    if (
      typeof implementation !== "string" ||
      typeof beacon !== "string" ||
      typeof resolved?.beaconOwner !== "string"
    ) {
      fail("missing Aave V2 family deployment data");
    }
    return [
      {
        address: implementation,
        contract: "contracts/strategies/AaveV3StrategyV2.sol:AaveV3StrategyV2",
        constructorArgs: [],
        label: "Aave V2 implementation",
        slug: "aave-v2-implementation",
      },
      {
        address: beacon,
        contract:
          "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
        constructorArgs: [implementation, resolved.beaconOwner],
        label: "Aave V2 beacon",
        slug: "aave-v2-beacon",
      },
    ];
  }

  if (ghoImplementationArtifact !== null) {
    if (
      ghoImplementationArtifact.artifact.contractName !== "GsmStkGhoStrategy"
    ) {
      fail("unexpected GHO family artifact contract");
    }
    const resolved = manifest.resolvedParams?.GhoStrategyFamilyModule as
      | { beaconOwner?: string }
      | undefined;
    const implementation =
      deployedAddresses["GhoStrategyFamilyModule#GhoStrategyImplementation"];
    const beacon =
      deployedAddresses["GhoStrategyFamilyModule#GhoStrategyBeacon"];
    if (
      typeof implementation !== "string" ||
      typeof beacon !== "string" ||
      typeof resolved?.beaconOwner !== "string"
    ) {
      fail("missing GHO family deployment data");
    }
    return [
      {
        address: implementation,
        contract:
          "contracts/strategies/GsmStkGhoStrategy.sol:GsmStkGhoStrategy",
        constructorArgs: [],
        label: "GHO strategy implementation",
        slug: "gho-strategy-implementation",
      },
      {
        address: beacon,
        contract:
          "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
        constructorArgs: [implementation, resolved.beaconOwner],
        label: "GHO strategy beacon",
        slug: "gho-strategy-beacon",
      },
    ];
  }

  return [];
}

export function targetForLane(
  deploymentDir: string,
  manifest: Manifest,
  deployedAddresses: Record<string, string>,
): VerificationTarget[] {
  const artifactsDir = join(deploymentDir, "artifacts");
  const strategyArtifact = findArtifact(artifactsDir, "#Strategy.json");
  if (strategyArtifact === null) {
    return [];
  }

  const aaveProxyAddress =
    deployedAddresses["StrategyV2LaneModule#StrategyV2Proxy"];
  const ghoProxyAddress =
    deployedAddresses["GhoStrategyLaneModule#GhoStrategyProxy"];
  if (
    typeof aaveProxyAddress === "string" &&
    typeof ghoProxyAddress === "string"
  ) {
    fail("ambiguous V2 lane deployment: found both Aave and GHO lane proxies");
  }

  const resolved = manifest.resolvedParams ?? {};

  if (strategyArtifact.artifact.contractName === "AaveV3StrategyV2") {
    if (typeof aaveProxyAddress !== "string") {
      fail("missing Aave V2 lane proxy deployment data");
    }
    const params = resolved.StrategyV2LaneModule as
      | {
          aToken?: Address;
          aavePool?: Address;
          strategyBeacon?: Address;
          strategyName?: string;
          vaultProxy?: Address;
          vaultToken?: Address;
        }
      | undefined;
    if (
      typeof params?.strategyBeacon !== "string" ||
      typeof params?.vaultProxy !== "string" ||
      typeof params?.aavePool !== "string" ||
      typeof params?.vaultToken !== "string" ||
      typeof params?.aToken !== "string" ||
      typeof params?.strategyName !== "string"
    ) {
      fail("missing Aave V2 lane deployment data");
    }
    const initializeCalldata = encodeFunctionData({
      abi: AAVE_V2_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        params.vaultProxy,
        params.aavePool,
        params.vaultToken,
        params.aToken,
        params.strategyName,
      ],
    });
    return [
      {
        address: aaveProxyAddress,
        contract:
          "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy",
        constructorArgs: [params.strategyBeacon, initializeCalldata],
        label: "Aave V2 lane proxy",
        slug: "aave-v2-lane-proxy",
      },
    ];
  }

  if (strategyArtifact.artifact.contractName === "GsmStkGhoStrategy") {
    if (typeof ghoProxyAddress !== "string") {
      fail("missing GHO lane proxy deployment data");
    }
    const params = resolved.GhoStrategyLaneModule as
      | {
          gsmAdapter?: Address;
          stkGhoRewardsDistributor?: Address;
          stkGhoToken?: Address;
          strategyBeacon?: Address;
          strategyName?: string;
          vaultProxy?: Address;
        }
      | undefined;
    if (
      typeof params?.strategyBeacon !== "string" ||
      typeof params?.vaultProxy !== "string" ||
      typeof params?.stkGhoToken !== "string" ||
      typeof params?.gsmAdapter !== "string" ||
      typeof params?.stkGhoRewardsDistributor !== "string" ||
      typeof params?.strategyName !== "string"
    ) {
      fail("missing GHO lane deployment data");
    }
    const initializeCalldata = encodeFunctionData({
      abi: GHO_STRATEGY_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        params.vaultProxy,
        params.stkGhoToken,
        params.gsmAdapter,
        params.stkGhoRewardsDistributor,
        params.strategyName,
      ],
    });
    return [
      {
        address: ghoProxyAddress,
        contract:
          "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy",
        constructorArgs: [params.strategyBeacon, initializeCalldata],
        label: "GHO lane proxy",
        slug: "gho-lane-proxy",
      },
    ];
  }

  return [];
}

export function resolveVerificationTargets(
  deploymentDir: string,
  manifest: Manifest,
  deployedAddresses: Record<string, string>,
): VerificationTarget[] {
  const familyTargets = targetForFamily(
    deploymentDir,
    manifest,
    deployedAddresses,
  );
  const laneTargets = targetForLane(deploymentDir, manifest, deployedAddresses);
  if (familyTargets.length !== 0 && laneTargets.length !== 0) {
    fail(
      "deployment dir is ambiguous: found both family and lane verification targets",
    );
  }
  if (familyTargets.length !== 0) {
    return familyTargets;
  }
  if (laneTargets.length !== 0) {
    return laneTargets;
  }
  fail(`could not identify a V2 beacon deployment in ${deploymentDir}`);
}

export function loadVerificationTargetsFromDeploymentDir(
  deploymentDir: string,
): LoadedVerificationTargets {
  const manifestPath = join(deploymentDir, "manifest.json");
  const deployedAddressesPath = join(deploymentDir, "deployed_addresses.json");
  if (!existsSync(manifestPath) || !existsSync(deployedAddressesPath)) {
    fail(`missing Ignition deployment artifacts in ${deploymentDir}`);
  }

  const manifest = readJson<Manifest>(manifestPath);
  const deployedAddresses = readJson<Record<string, string>>(
    deployedAddressesPath,
  );
  const network = manifest.network?.name;
  if (typeof network !== "string" || network.length === 0) {
    fail("deployment manifest is missing network.name");
  }

  return {
    network,
    targets: resolveVerificationTargets(
      deploymentDir,
      manifest,
      deployedAddresses,
    ),
  };
}

async function runVerify(args: {
  address: string;
  contract: string;
  constructorArgs: unknown[];
  force: boolean;
  network: string;
  slug: string;
}): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "defivault-verify-v2-"));
  const constructorArgsPath = join(
    tempDir,
    `${args.slug}.constructor-args.mjs`,
  );
  writeDefaultExportModule(constructorArgsPath, args.constructorArgs);

  const verifyArgs = [
    "hardhat",
    "verify",
    "--network",
    args.network,
    "--contract",
    args.contract,
    "--constructor-args-path",
    constructorArgsPath,
  ];
  if (args.force) {
    verifyArgs.push("--force");
  }
  verifyArgs.push(args.address);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("npx", verifyArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      rmSync(tempDir, { recursive: true, force: true });
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`verification failed with exit code ${code ?? -1}`),
      );
    });
  });
}

export async function main() {
  const { deploymentDir, force } = parseArgs(process.argv.slice(2));
  const { network, targets } =
    loadVerificationTargetsFromDeploymentDir(deploymentDir);

  for (const target of targets) {
    console.log(`[verify] ${target.label}: ${target.address}`);
    await runVerify({
      address: target.address,
      contract: target.contract,
      constructorArgs: target.constructorArgs,
      force,
      network,
      slug: target.slug,
    });
  }
}

if (process.argv[1] !== undefined) {
  const currentFilePath = fileURLToPath(import.meta.url);
  if (resolve(process.argv[1]) === currentFilePath) {
    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
