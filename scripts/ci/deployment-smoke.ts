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

function writeModuleParams(
  fileName: string,
  moduleName: string,
  payload: Record<string, unknown>,
): string {
  const path = join(paramsDir, fileName);
  writeJson(path, { [moduleName]: payload });
  return path;
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

async function runIgnitionDeploy(
  name: string,
  modulePath: string,
  paramsPath: string,
  deploymentId: string,
  outputFile: string,
) {
  await runCommand(name, "npx", [
    "hardhat",
    "ignition",
    "deploy",
    modulePath,
    "--network",
    "localhost",
    "--parameters",
    paramsPath,
    "--deployment-id",
    deploymentId,
    "--reset",
  ]);

  const deployedAddresses = readIgnitionDeployedAddresses(deploymentId);
  writeJson(join(outputsDir, outputFile), deployedAddresses);
  return deployedAddresses;
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
  const allocator = deployAdmin;
  const rebalancer = deployAdmin;
  const pauser = deployAdmin;
  const l2ExchangeRecipient = normalizeAddress(
    wallets[4]?.account?.address ??
      "0x0000000000000000000000000000000000000d11",
  );
  const yieldRecipient = normalizeAddress(
    "0x243bd52D0765a8F2831f0873D6a99D56c1Daa517",
  );

  const bridgeHub = await viem.deployContract("MockL1ZkSyncBridgeAdapter");
  const grvtBridgeProxyFeeToken = await viem.deployContract("MockERC20", [
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

  const l2ChainId = 327n;
  const strategyName = "AAVE_V3_UNDERLYING";
  const strategyCap = 0n;
  const smokeRunId = `${Date.now()}`;

  writeJson(join(outputsDir, "prerequisites.json"), {
    deployAdmin,
    allocator,
    rebalancer,
    pauser,
    yieldRecipient,
    bridgeHub: bridgeHub.address,
    grvtBridgeProxyFeeToken: grvtBridgeProxyFeeToken.address,
    wrappedNativeToken: wrappedNativeToken.address,
    underlyingToken: underlyingToken.address,
    aavePool: aavePool.address,
    aToken: aToken.address,
    l2ChainId: `${l2ChainId}n`,
    l2ExchangeRecipient,
    strategyName,
    strategyCap: `${strategyCap}n`,
  });

  const vaultCoreParamsPath = writeModuleParams(
    "vault-core.temp.json",
    "VaultCoreModule",
    {
      deployAdmin,
      bridgeHub: bridgeHub.address,
      grvtBridgeProxyFeeToken: grvtBridgeProxyFeeToken.address,
      l2ChainId: `${l2ChainId}n`,
      l2ExchangeRecipient,
      wrappedNativeToken: wrappedNativeToken.address,
      yieldRecipient,
    },
  );

  const vaultCoreDeploymentId = `smoke-vault-core-${smokeRunId}`;
  const vaultCoreDeployedAddresses = await runIgnitionDeploy(
    "ignition-vault-core",
    "./ignition/modules/VaultCore.ts",
    vaultCoreParamsPath,
    vaultCoreDeploymentId,
    "vault-core-deployed-addresses.json",
  );
  const vaultImplementation = requiredDeployedAddress(
    vaultCoreDeployedAddresses,
    "VaultCoreModule#VaultImplementation",
  );
  const vaultProxy = requiredDeployedAddress(
    vaultCoreDeployedAddresses,
    "VaultCoreModule#VaultProxy",
  );
  const vaultProxyAdmin = await readProxyAdminAddress(publicClient, vaultProxy);

  const vault = await viem.getContractAt("GRVTL1TreasuryVault", vaultProxy);
  recordEq(
    assertions,
    "vault.bridgeHub",
    await vault.read.bridgeHub(),
    bridgeHub.address,
  );
  recordEq(
    assertions,
    "vault.grvtBridgeProxyFeeToken",
    await vault.read.grvtBridgeProxyFeeToken(),
    grvtBridgeProxyFeeToken.address,
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
  recordEq(
    assertions,
    "vault.yieldRecipient",
    await vault.read.yieldRecipient(),
    yieldRecipient,
  );

  const strategyCoreParamsPath = writeModuleParams(
    "strategy-core.temp.json",
    "StrategyCoreModule",
    {
      vaultProxy,
      proxyAdminOwner: deployAdmin,
      aavePool: aavePool.address,
      underlyingToken: underlyingToken.address,
      aToken: aToken.address,
      strategyName,
    },
  );

  const strategyCoreDeploymentId = `smoke-strategy-core-${smokeRunId}`;
  const strategyCoreDeployedAddresses = await runIgnitionDeploy(
    "ignition-strategy-core",
    "./ignition/modules/StrategyCore.ts",
    strategyCoreParamsPath,
    strategyCoreDeploymentId,
    "strategy-core-deployed-addresses.json",
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
    publicClient,
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

  const vaultTokenStrategyParamsPath = writeModuleParams(
    "vault-token-strategy.temp.json",
    "VaultTokenStrategyModule",
    {
      vaultProxy,
      strategyProxy,
      vaultToken: underlyingToken.address,
      vaultTokenSupported: true,
      vaultTokenStrategyWhitelisted: true,
      strategyCap: `${strategyCap}n`,
    },
  );
  const rolesBootstrapParamsPath = writeModuleParams(
    "roles-bootstrap.temp.json",
    "VaultRolesBootstrapModule",
    {
      vaultProxy,
      allocator,
      rebalancer,
      pauser,
    },
  );
  const nativeGatewaysParamsPath = writeModuleParams(
    "native-gateways.temp.json",
    "NativeGatewaysModule",
    {
      wrappedNativeToken: wrappedNativeToken.address,
      grvtBridgeProxyFeeToken: grvtBridgeProxyFeeToken.address,
      bridgeHub: bridgeHub.address,
      vaultProxy,
      proxyAdminOwner: deployAdmin,
    },
  );

  const vaultTokenStrategyDeploymentId = `smoke-vault-token-strategy-${smokeRunId}`;
  await runIgnitionDeploy(
    "ignition-vault-token-strategy",
    "./ignition/modules/VaultTokenStrategy.ts",
    vaultTokenStrategyParamsPath,
    vaultTokenStrategyDeploymentId,
    "vault-token-strategy-deployed-addresses.json",
  );

  const vaultTokenConfig = await vault.read.getVaultTokenConfig([
    underlyingToken.address,
  ]);
  const vaultTokenStrategyConfig = await vault.read.getVaultTokenStrategyConfig(
    [underlyingToken.address, strategyProxy],
  );
  recordEq(
    assertions,
    "vaultTokenConfig.supported",
    vaultTokenConfig.supported,
    true,
  );
  recordEq(
    assertions,
    "vaultTokenStrategyConfig.whitelisted",
    vaultTokenStrategyConfig.whitelisted,
    true,
  );
  // whitelisted=true always transitions strategy to active=true in vault lifecycle rules.
  recordEq(
    assertions,
    "vaultTokenStrategyConfig.active",
    vaultTokenStrategyConfig.active,
    true,
  );
  recordEq(
    assertions,
    "vaultTokenStrategyConfig.cap",
    vaultTokenStrategyConfig.cap,
    strategyCap,
  );

  const rolesDeploymentId = `smoke-roles-${smokeRunId}`;
  await runIgnitionDeploy(
    "ignition-roles-bootstrap",
    "./ignition/modules/VaultRolesBootstrap.ts",
    rolesBootstrapParamsPath,
    rolesDeploymentId,
    "roles-bootstrap-deployed-addresses.json",
  );

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

  const nativeGatewaysDeploymentId = `smoke-native-gateways-${smokeRunId}`;
  const nativeGatewaysDeployedAddresses = await runIgnitionDeploy(
    "ignition-native-gateways",
    "./ignition/modules/NativeGateways.ts",
    nativeGatewaysParamsPath,
    nativeGatewaysDeploymentId,
    "native-gateways-deployed-addresses.json",
  );
  const nativeVaultGatewayAddress = requiredDeployedAddress(
    nativeGatewaysDeployedAddresses,
    "NativeGatewaysModule#NativeVaultGateway",
  );
  const nativeBridgeGatewayImplementation = requiredDeployedAddress(
    nativeGatewaysDeployedAddresses,
    "NativeGatewaysModule#NativeBridgeGatewayImplementation",
  );
  const nativeBridgeGatewayProxy = requiredDeployedAddress(
    nativeGatewaysDeployedAddresses,
    "NativeGatewaysModule#NativeBridgeGatewayProxy",
  );
  const nativeBridgeGatewayProxyAdmin = await readProxyAdminAddress(
    publicClient,
    nativeBridgeGatewayProxy,
  );

  const nativeVaultGateway = await viem.getContractAt(
    "NativeVaultGateway",
    nativeVaultGatewayAddress,
  );
  const nativeBridgeGateway = await viem.getContractAt(
    "NativeBridgeGateway",
    nativeBridgeGatewayProxy,
  );
  recordEq(
    assertions,
    "nativeVaultGateway.wrappedNativeToken",
    await nativeVaultGateway.read.wrappedNativeToken(),
    wrappedNativeToken.address,
  );
  recordEq(
    assertions,
    "nativeVaultGateway.vault",
    await nativeVaultGateway.read.vault(),
    vaultProxy,
  );
  recordEq(
    assertions,
    "nativeBridgeGateway.wrappedNativeToken",
    await nativeBridgeGateway.read.wrappedNativeToken(),
    wrappedNativeToken.address,
  );
  recordEq(
    assertions,
    "nativeBridgeGateway.grvtBridgeProxyFeeToken",
    await nativeBridgeGateway.read.grvtBridgeProxyFeeToken(),
    grvtBridgeProxyFeeToken.address,
  );
  recordEq(
    assertions,
    "nativeBridgeGateway.bridgeHub",
    await nativeBridgeGateway.read.bridgeHub(),
    bridgeHub.address,
  );
  recordEq(
    assertions,
    "nativeBridgeGateway.vault",
    await nativeBridgeGateway.read.vault(),
    vaultProxy,
  );
  recordEq(
    assertions,
    "vault.nativeBridgeGateway",
    await vault.read.nativeBridgeGateway(),
    nativeBridgeGatewayProxy,
  );

  const wrappedNative = await viem.getContractAt(
    "MockWETH",
    wrappedNativeToken.address,
  );
  const vaultWethBefore = await wrappedNative.read.balanceOf([vaultProxy]);
  await nativeVaultGateway.write.depositToVault({ value: 1n });
  const vaultWethAfter = await wrappedNative.read.balanceOf([vaultProxy]);
  recordEq(
    assertions,
    "nativeVaultGateway.depositWrapForwardDelta",
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
    nativeVaultGateway: nativeVaultGatewayAddress,
    nativeBridgeGatewayImplementation,
    nativeBridgeGatewayProxy,
    nativeBridgeGatewayProxyAdmin,
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
