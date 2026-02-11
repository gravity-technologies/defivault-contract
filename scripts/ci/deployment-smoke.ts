import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { network } from "hardhat";
import { getAddress, isAddress, type Address, type Hex } from "viem";

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

type AssertionRecord = {
  name: string;
  expected: string;
  actual: string;
};

const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

const repoRoot = process.cwd();
const smokeDir = resolve(repoRoot, "smoke-artifacts");
const logsDir = join(smokeDir, "logs");
const outputsDir = join(smokeDir, "outputs");
const paramsDir = join(smokeDir, "params");

function ensureDirs() {
  // Keep root-level smoke-artifacts files (e.g. CI hardhat-node.pid/log) intact.
  mkdirSync(smokeDir, { recursive: true });
  rmSync(logsDir, { recursive: true, force: true });
  rmSync(outputsDir, { recursive: true, force: true });
  rmSync(paramsDir, { recursive: true, force: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });
  mkdirSync(paramsDir, { recursive: true });
}

function normalizeAddress(address: string): Address {
  if (!isAddress(address)) throw new Error(`invalid address: ${address}`);
  return getAddress(address);
}

function writeJson(path: string, payload: unknown) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function readIgnitionDeployedAddresses(
  deploymentId: string,
): Record<string, string> {
  const deployedAddressesPath = join(
    repoRoot,
    `ignition/deployments/${deploymentId}/deployed_addresses.json`,
  );
  return JSON.parse(readFileSync(deployedAddressesPath, "utf8")) as Record<
    string,
    string
  >;
}

function requiredDeployedAddress(
  deployedAddresses: Record<string, string>,
  key: string,
): Address {
  const value = deployedAddresses[key];
  if (value === undefined) {
    throw new Error(`missing ${key} in deployed_addresses.json`);
  }
  return normalizeAddress(value);
}

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
  if (raw === undefined) throw new Error("missing proxy admin slot value");
  const hex = raw.slice(2);
  const admin = `0x${hex.slice(24)}` as Address;
  return getAddress(admin);
}

async function runCommand(
  name: string,
  command: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", resolveCode);
  });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  writeFileSync(join(logsDir, `${name}.stdout.log`), stdout);
  writeFileSync(join(logsDir, `${name}.stderr.log`), stderr);

  if (code !== 0) {
    throw new Error(
      `${name} failed with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return { stdout, stderr, code };
}

function recordEq(
  assertions: AssertionRecord[],
  name: string,
  actual: string | bigint | boolean,
  expected: string | bigint | boolean,
) {
  let actualText = String(actual);
  let expectedText = String(expected);
  if (isAddress(actualText) && isAddress(expectedText)) {
    actualText = getAddress(actualText);
    expectedText = getAddress(expectedText);
  }
  assertions.push({ name, actual: actualText, expected: expectedText });
  assert.equal(actualText, expectedText, `${name} mismatch`);
}

function writeParamsFiles(base: {
  deployAdmin: Address;
  bridgeHub: Address;
  baseToken: Address;
  l2ChainId: bigint;
  l2ExchangeRecipient: Address;
  wrappedNativeToken: Address;
}) {
  const vaultCoreParamsPath = join(paramsDir, "vault-core.temp.json");
  writeJson(vaultCoreParamsPath, {
    VaultCoreModule: {
      deployAdmin: base.deployAdmin,
      bridgeHub: base.bridgeHub,
      baseToken: base.baseToken,
      l2ChainId: `${base.l2ChainId}n`,
      l2ExchangeRecipient: base.l2ExchangeRecipient,
      wrappedNativeToken: base.wrappedNativeToken,
    },
  });
  return { vaultCoreParamsPath };
}

async function main() {
  ensureDirs();
  const assertions: AssertionRecord[] = [];

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  if (wallets.length === 0 || wallets[0].account === undefined) {
    throw new Error("localhost network has no deployer wallet");
  }

  const deployer = wallets[0];
  const deployAdmin = normalizeAddress(deployer.account.address);
  const allocator = normalizeAddress(
    wallets[1]?.account?.address ??
      "0x0000000000000000000000000000000000000a11",
  );
  const rebalancer = normalizeAddress(
    wallets[2]?.account?.address ??
      "0x0000000000000000000000000000000000000b11",
  );
  const pauser = normalizeAddress(
    wallets[3]?.account?.address ??
      "0x0000000000000000000000000000000000000c11",
  );
  const l2ExchangeRecipient = normalizeAddress(
    wallets[4]?.account?.address ??
      "0x0000000000000000000000000000000000000d11",
  );

  const bridgeHub = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
  const baseToken = await viem.deployContract("MockERC20", [
    "Mock Base",
    "mBASE",
    18,
  ]);
  const wrappedNativeToken = await viem.deployContract("MockWETH");
  const underlyingToken = await viem.deployContract("MockERC20", [
    "Mock USDT",
    "mUSDT",
    6,
  ]);
  const aavePool = await viem.deployContract("MockAaveV3Pool", [
    underlyingToken.address,
  ]);
  const aToken = await viem.deployContract("MockAaveV3AToken", [
    underlyingToken.address,
    aavePool.address,
    "Mock Aave USDT",
    "aUSDT",
  ]);
  await aavePool.write.setAToken([aToken.address]);

  const l2ChainId = 270n;
  const strategyName = "AAVE_V3_UNDERLYING";
  const strategyCap = 1_000_000n;
  const smokeRunId = `${Date.now()}`;

  writeJson(join(outputsDir, "prerequisites.json"), {
    deployAdmin,
    allocator,
    rebalancer,
    pauser,
    bridgeHub: bridgeHub.address,
    baseToken: baseToken.address,
    wrappedNativeToken: wrappedNativeToken.address,
    underlyingToken: underlyingToken.address,
    aavePool: aavePool.address,
    aToken: aToken.address,
    l2ChainId: `${l2ChainId}n`,
    l2ExchangeRecipient,
    strategyName,
    strategyCap: `${strategyCap}n`,
  });

  const { vaultCoreParamsPath } = writeParamsFiles({
    deployAdmin,
    bridgeHub: bridgeHub.address,
    baseToken: baseToken.address,
    l2ChainId,
    l2ExchangeRecipient,
    wrappedNativeToken: wrappedNativeToken.address,
  });

  const vaultCoreDeploymentId = `smoke-vault-core-${smokeRunId}`;
  await runCommand("ignition-vault-core", "npx", [
    "hardhat",
    "ignition",
    "deploy",
    "./ignition/modules/VaultCore.ts",
    "--network",
    "localhost",
    "--parameters",
    vaultCoreParamsPath,
    "--deployment-id",
    vaultCoreDeploymentId,
    "--reset",
  ]);
  const vaultCoreDeployedAddresses = readIgnitionDeployedAddresses(
    vaultCoreDeploymentId,
  );
  writeJson(
    join(outputsDir, "vault-core-deployed-addresses.json"),
    vaultCoreDeployedAddresses,
  );
  const vaultImplementation = requiredDeployedAddress(
    vaultCoreDeployedAddresses,
    "VaultCoreModule#VaultImplementation",
  );
  const vaultProxy = requiredDeployedAddress(
    vaultCoreDeployedAddresses,
    "VaultCoreModule#VaultProxy",
  );
  const vaultProxyAdmin = await readProxyAdminAddress(
    {
      getStorageAt: (args) =>
        publicClient.getStorageAt({
          address: args.address,
          slot: args.slot,
        }),
    },
    vaultProxy,
  );

  const vault = await viem.getContractAt("GRVTDeFiVault", vaultProxy);
  recordEq(
    assertions,
    "vault.bridgeHub",
    await vault.read.bridgeHub(),
    bridgeHub.address,
  );
  recordEq(
    assertions,
    "vault.baseToken",
    await vault.read.baseToken(),
    baseToken.address,
  );
  recordEq(
    assertions,
    "vault.l2ChainId",
    await vault.read.l2ChainId(),
    l2ChainId,
  );
  recordEq(
    assertions,
    "vault.l2ExchangeRecipient",
    await vault.read.l2ExchangeRecipient(),
    l2ExchangeRecipient,
  );
  recordEq(
    assertions,
    "vault.wrappedNativeToken",
    await vault.read.wrappedNativeToken(),
    wrappedNativeToken.address,
  );

  const strategyCoreParamsPath = join(paramsDir, "strategy-core.temp.json");
  writeJson(strategyCoreParamsPath, {
    StrategyCoreModule: {
      vaultProxy,
      proxyAdminOwner: deployAdmin,
      aavePool: aavePool.address,
      underlyingToken: underlyingToken.address,
      aToken: aToken.address,
      strategyName,
    },
  });

  const strategyCoreDeploymentId = `smoke-strategy-core-${smokeRunId}`;
  await runCommand("ignition-strategy-core", "npx", [
    "hardhat",
    "ignition",
    "deploy",
    "./ignition/modules/StrategyCore.ts",
    "--network",
    "localhost",
    "--parameters",
    strategyCoreParamsPath,
    "--deployment-id",
    strategyCoreDeploymentId,
    "--reset",
  ]);
  const strategyCoreDeployedAddresses = readIgnitionDeployedAddresses(
    strategyCoreDeploymentId,
  );
  writeJson(
    join(outputsDir, "strategy-core-deployed-addresses.json"),
    strategyCoreDeployedAddresses,
  );
  const strategyImplementation = requiredDeployedAddress(
    strategyCoreDeployedAddresses,
    "StrategyCoreModule#StrategyImplementation",
  );
  const strategyProxy = requiredDeployedAddress(
    strategyCoreDeployedAddresses,
    "StrategyCoreModule#StrategyProxy",
  );
  const strategyProxyAdmin = await readProxyAdminAddress(
    {
      getStorageAt: (args) =>
        publicClient.getStorageAt({
          address: args.address,
          slot: args.slot,
        }),
    },
    strategyProxy,
  );

  const strategy = await viem.getContractAt("AaveV3Strategy", strategyProxy);
  recordEq(
    assertions,
    "strategy.vault",
    await strategy.read.vault(),
    vaultProxy,
  );
  recordEq(
    assertions,
    "strategy.aavePool",
    await strategy.read.aavePool(),
    aavePool.address,
  );
  recordEq(
    assertions,
    "strategy.underlying",
    await strategy.read.underlying(),
    underlyingToken.address,
  );
  recordEq(
    assertions,
    "strategy.aToken",
    await strategy.read.aToken(),
    aToken.address,
  );

  const tokenStrategyParamsPath = join(paramsDir, "token-strategy.temp.json");
  writeJson(tokenStrategyParamsPath, {
    TokenStrategyModule: {
      vaultProxy,
      strategyProxy,
      underlyingToken: underlyingToken.address,
      tokenSupported: true,
      strategyWhitelisted: true,
      strategyActive: false,
      strategyCap: `${strategyCap}n`,
    },
  });
  const rolesBootstrapParamsPath = join(paramsDir, "roles-bootstrap.temp.json");
  writeJson(rolesBootstrapParamsPath, {
    VaultRolesBootstrapModule: {
      vaultProxy,
      allocator,
      rebalancer,
      pauser,
    },
  });
  const nativeIngressParamsPath = join(paramsDir, "native-ingress.temp.json");
  writeJson(nativeIngressParamsPath, {
    NativeIngressModule: {
      wrappedNativeToken: wrappedNativeToken.address,
      vaultProxy,
    },
  });

  const tokenStrategyDeploymentId = `smoke-token-strategy-${smokeRunId}`;
  await runCommand("ignition-token-strategy", "npx", [
    "hardhat",
    "ignition",
    "deploy",
    "./ignition/modules/TokenStrategy.ts",
    "--network",
    "localhost",
    "--parameters",
    tokenStrategyParamsPath,
    "--deployment-id",
    tokenStrategyDeploymentId,
    "--reset",
  ]);

  const tokenConfig = await vault.read.getTokenConfig([
    underlyingToken.address,
  ]);
  const strategyConfig = await vault.read.getStrategyConfig([
    underlyingToken.address,
    strategyProxy,
  ]);
  recordEq(assertions, "tokenConfig.supported", tokenConfig.supported, true);
  recordEq(
    assertions,
    "strategyConfig.whitelisted",
    strategyConfig.whitelisted,
    true,
  );
  // whitelisted=true always transitions strategy to active=true in vault lifecycle rules.
  recordEq(assertions, "strategyConfig.active", strategyConfig.active, true);
  recordEq(assertions, "strategyConfig.cap", strategyConfig.cap, strategyCap);

  const rolesDeploymentId = `smoke-roles-${smokeRunId}`;
  await runCommand("ignition-roles-bootstrap", "npx", [
    "hardhat",
    "ignition",
    "deploy",
    "./ignition/modules/VaultRolesBootstrap.ts",
    "--network",
    "localhost",
    "--parameters",
    rolesBootstrapParamsPath,
    "--deployment-id",
    rolesDeploymentId,
    "--reset",
  ]);

  const allocatorRole = await vault.read.ALLOCATOR_ROLE();
  const rebalancerRole = await vault.read.REBALANCER_ROLE();
  const pauserRole = await vault.read.PAUSER_ROLE();
  recordEq(
    assertions,
    "hasRole.ALLOCATOR",
    await vault.read.hasRole([allocatorRole, allocator]),
    true,
  );
  recordEq(
    assertions,
    "hasRole.REBALANCER",
    await vault.read.hasRole([rebalancerRole, rebalancer]),
    true,
  );
  recordEq(
    assertions,
    "hasRole.PAUSER",
    await vault.read.hasRole([pauserRole, pauser]),
    true,
  );

  const nativeIngressDeploymentId = `smoke-native-ingress-${smokeRunId}`;
  await runCommand("ignition-native-ingress", "npx", [
    "hardhat",
    "ignition",
    "deploy",
    "./ignition/modules/NativeIngress.ts",
    "--network",
    "localhost",
    "--parameters",
    nativeIngressParamsPath,
    "--deployment-id",
    nativeIngressDeploymentId,
    "--reset",
  ]);

  const deployedAddressesPath = join(
    repoRoot,
    `ignition/deployments/${nativeIngressDeploymentId}/deployed_addresses.json`,
  );
  const deployedAddresses = JSON.parse(
    readFileSync(deployedAddressesPath, "utf8"),
  ) as Record<string, string>;
  writeJson(
    join(outputsDir, "native-ingress-deployed-addresses.json"),
    deployedAddresses,
  );
  const nativeIngressAddressRaw =
    deployedAddresses["NativeIngressModule#NativeIngress"];
  if (nativeIngressAddressRaw === undefined) {
    throw new Error(
      "missing NativeIngressModule#NativeIngress in deployed_addresses.json",
    );
  }
  const nativeIngressAddress = normalizeAddress(nativeIngressAddressRaw);

  const nativeIngress = await viem.getContractAt(
    "NativeToWrappedIngress",
    nativeIngressAddress,
  );
  recordEq(
    assertions,
    "nativeIngress.wrappedNativeToken",
    await nativeIngress.read.wrappedNativeToken(),
    wrappedNativeToken.address,
  );
  recordEq(
    assertions,
    "nativeIngress.vault",
    await nativeIngress.read.vault(),
    vaultProxy,
  );

  const wrappedNative = await viem.getContractAt(
    "MockWETH",
    wrappedNativeToken.address,
  );
  const vaultWethBefore = await wrappedNative.read.balanceOf([vaultProxy]);
  await nativeIngress.write.ingress({ value: 1n });
  const vaultWethAfter = await wrappedNative.read.balanceOf([vaultProxy]);
  recordEq(
    assertions,
    "nativeIngress.ingressWrapForwardDelta",
    vaultWethAfter - vaultWethBefore,
    1n,
  );

  writeJson(join(outputsDir, "assertions.json"), assertions);
  writeFileSync(
    join(outputsDir, "assertions.log"),
    `${assertions.map((a) => `PASS ${a.name} expected=${a.expected} actual=${a.actual}`).join("\n")}\n`,
  );

  writeJson(join(outputsDir, "summary.json"), {
    chainId: await publicClient.getChainId(),
    vaultImplementation,
    vaultProxy,
    vaultProxyAdmin,
    strategyImplementation,
    strategyProxy,
    strategyProxyAdmin,
    nativeIngress: nativeIngressAddress,
    assertions: assertions.length,
  });
}

main().catch((error) => {
  try {
    writeFileSync(join(outputsDir, "failure.log"), `${String(error)}\n`);
  } catch {
    // no-op
  }
  console.error(error);
  process.exitCode = 1;
});
