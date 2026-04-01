#!/usr/bin/env node

import "dotenv/config";

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import {
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import {
  readOperationRecord,
  type OperationRecord,
} from "../deploy/operation-records.js";
import {
  proxyAdminAbi,
  readProxyAdminAddress,
} from "../../tasks/utils/proxy-admin.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

const EXPECTED_BOOTSTRAP_DEPLOYER = getAddress(
  "0x340d75F15bF97aF6AE518d746063c591bB5368f0",
);
const EXPECTED_FINAL_VAULT_ADMIN = getAddress(
  "0x3a23919d4aA39e096E9d6420fd6a2861A20B19e5",
);
const EXPECTED_TREASURY_RECIPIENT = getAddress(
  "0x6e1B2a22f8f3768040CFb0b0997851ffB5971439",
);
const EXPECTED_HAOZE_OPERATOR = getAddress(
  "0x4738eDE7Fb2d3E5596867cf60c668779de7CE8C4",
);
const EXPECTED_MINH_OPERATOR = getAddress(
  "0x29496817aB0820A5aDa4d5C656Ea8DF79Ba05F3A",
);
const EXPECTED_AARON_OPERATOR = getAddress(
  "0x9A4484BBDae765A84c802Cf0A4777D8b16AB1270",
);
const EXPECTED_L1_BRIDGE_HUB = getAddress(
  "0x303a465B659cBB0ab36eE643eA362c509EEb5213",
);
const EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN = getAddress(
  "0xAB3B124052F0389D1cbED221d912026Ac995bb95",
);
const EXPECTED_WRAPPED_NATIVE_TOKEN = getAddress(
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
);
const EXPECTED_AAVE_V3_POOL = getAddress(
  "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
);
const EXPECTED_USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
const EXPECTED_AUSDT = getAddress("0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a");
const EXPECTED_L2_CHAIN_ID = 325n;
const EXPECTED_L2_EXCHANGE_RECIPIENT = getAddress(
  "0x85deE82d32d78eaa59588B6574Df420ef2A74098",
);
const EXPECTED_SAFE_THRESHOLD = 2n;
const EXPECTED_SAFE_OWNER_COUNT = 3;
const EXPECTED_STRATEGY_NAME = "AAVE_V3_ETHEREUM_USDT";

const TIMELOCK_ADMIN_ROLE = zeroHash;
const TIMELOCK_PROPOSER_ROLE = keccak256(stringToHex("PROPOSER_ROLE"));
const TIMELOCK_EXECUTOR_ROLE = keccak256(stringToHex("EXECUTOR_ROLE"));
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const accessControlAbi = parseAbi([
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);
const vaultRoleAbi = parseAbi([
  "function VAULT_ADMIN_ROLE() view returns (bytes32)",
  "function REBALANCER_ROLE() view returns (bytes32)",
  "function ALLOCATOR_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
]);
const vaultConfigAbi = parseAbi([
  "function bridgeHub() view returns (address)",
  "function grvtBridgeProxyFeeToken() view returns (address)",
  "function l2ChainId() view returns (uint256)",
  "function l2ExchangeRecipient() view returns (address)",
  "function wrappedNativeToken() view returns (address)",
  "function nativeBridgeGateway() view returns (address)",
  "function yieldRecipient() view returns (address)",
  "function yieldRecipientTimelockController() view returns (address)",
]);
const strategyAbi = parseAbi([
  "function vault() view returns (address)",
  "function aavePool() view returns (address)",
  "function underlying() view returns (address)",
  "function aToken() view returns (address)",
  "function name() view returns (string)",
]);
const nativeBridgeGatewayAbi = parseAbi([
  "function vault() view returns (address)",
  "function wrappedNativeToken() view returns (address)",
  "function grvtBridgeProxyFeeToken() view returns (address)",
  "function bridgeHub() view returns (address)",
]);
const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const aTokenAbi = parseAbi([
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function POOL() view returns (address)",
]);
const feeTokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);

type CliOptions = {
  network?: string;
  recordPath?: string;
};

type InitialStackRecord = OperationRecord & {
  inputs: {
    resolvedParams: {
      nativeGateways: {
        bridgeHub: string;
        grvtBridgeProxyFeeToken: string;
        proxyAdminOwner: string;
        wrappedNativeToken: string;
      };
      productionAuthorityPlan: {
        bootstrapVaultAdmin: string;
        finalVaultAdmin: string;
      };
      strategyCore: {
        aToken: string;
        aavePool: string;
        proxyAdminOwner: string;
        strategyName: string;
        underlyingToken: string;
      };
      vaultCore: {
        bridgeHub: string;
        deployAdmin: string;
        finalVaultAdmin: string;
        grvtBridgeProxyFeeToken: string;
        l2ChainId: string;
        l2ExchangeRecipient: string;
        wrappedNativeToken: string;
        yieldRecipient: string;
      };
    };
  };
  outputs: {
    nativeBridgeGatewayImplementation: string;
    nativeBridgeGatewayProxy: string;
    nativeBridgeGatewayProxyAdmin: string;
    nativeVaultGateway: string;
    strategyImplementation: string;
    strategyProxy: string;
    strategyProxyAdmin: string;
    vaultImplementation: string;
    vaultProxy: string;
    vaultProxyAdmin: string;
    yieldRecipientTimelockController: string;
  };
};

type CheckResult = {
  details?: string;
  label: string;
  ok: boolean;
};

type WarningResult = {
  details: string;
  label: string;
};

function printUsage(): void {
  console.error(`Usage:
  npm run verify:production-final-state -- --network mainnet --record <path-to-initial-stack-record-or-dir>

Example:
  npm run verify:production-final-state -- --network mainnet --record deployment-records/production/2026-021141Z-initial-stack-minh
`);
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

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
      case "--record":
        options.recordPath = requireValue();
        index += 1;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (options.network === undefined) {
    fail("--network is required");
  }
  if (options.recordPath === undefined) {
    fail("--record is required");
  }

  return options;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not a valid address`);
  }
  return getAddress(value);
}

function parseBigIntText(value: string, label: string): bigint {
  const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
  try {
    return BigInt(normalized);
  } catch {
    throw new Error(`${label} is not a bigint text value: ${value}`);
  }
}

function requireInitialStackRecord(
  recordPathOrDir: string,
): InitialStackRecord {
  const record = readOperationRecord(recordPathOrDir);
  if (record.kind !== "initial-stack") {
    throw new Error(`expected initial-stack record, found ${record.kind}`);
  }
  if (
    typeof record.inputs !== "object" ||
    record.inputs === null ||
    typeof (record.inputs as Record<string, unknown>).resolvedParams !==
      "object" ||
    (record.inputs as Record<string, unknown>).resolvedParams === null
  ) {
    throw new Error("initial-stack record is missing resolvedParams");
  }
  if (typeof record.outputs !== "object" || record.outputs === null) {
    throw new Error("initial-stack record is missing outputs");
  }
  return record as InitialStackRecord;
}

function renderSection(title: string): void {
  console.log(`\n${chalk.bold(title)}`);
}

function pushPass(
  results: CheckResult[],
  label: string,
  details?: string,
): void {
  results.push({ details, label, ok: true });
}

function pushFail(results: CheckResult[], label: string, error: unknown): void {
  results.push({
    details: error instanceof Error ? error.message : String(error),
    label,
    ok: false,
  });
}

function pushWarning(
  warnings: WarningResult[],
  label: string,
  details: string,
): void {
  warnings.push({ details, label });
}

async function runCheck(
  results: CheckResult[],
  label: string,
  fn: () => Promise<string | undefined> | string | undefined,
): Promise<void> {
  try {
    pushPass(results, label, await fn());
  } catch (error) {
    pushFail(results, label, error);
  }
}

function assertAddressEqual(
  actual: Address,
  expected: Address,
  label: string,
): void {
  if (!sameAddress(actual, expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertBigIntEqual(
  actual: bigint,
  expected: bigint,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertStringEqual(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(label);
  }
}

async function requireDeployedContract(
  publicClient: {
    getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  },
  address: Address,
  label: string,
): Promise<void> {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} has no bytecode at ${address}`);
  }
}

async function requireEoa(
  publicClient: {
    getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  },
  address: Address,
  label: string,
): Promise<void> {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode !== undefined && bytecode !== "0x") {
    throw new Error(`${label} is not an EOA: ${address}`);
  }
}

async function readProxyImplementationAddress(
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
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  if (raw === undefined) {
    throw new Error("missing proxy implementation slot value");
  }
  const hex = raw.slice(2);
  return getAddress(`0x${hex.slice(24)}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const record = requireInitialStackRecord(
    resolve(REPO_ROOT, options.recordPath!),
  );

  const { network } = await import("hardhat");
  const { viem } = await network.connect(options.network!);
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const results: CheckResult[] = [];
  const warnings: WarningResult[] = [];

  const vaultProxy = requireAddress(record.outputs.vaultProxy, "vaultProxy");
  const vaultImplementation = requireAddress(
    record.outputs.vaultImplementation,
    "vaultImplementation",
  );
  const vaultProxyAdmin = requireAddress(
    record.outputs.vaultProxyAdmin,
    "vaultProxyAdmin",
  );
  const strategyProxy = requireAddress(
    record.outputs.strategyProxy,
    "strategyProxy",
  );
  const strategyImplementation = requireAddress(
    record.outputs.strategyImplementation,
    "strategyImplementation",
  );
  const strategyProxyAdmin = requireAddress(
    record.outputs.strategyProxyAdmin,
    "strategyProxyAdmin",
  );
  const nativeBridgeGatewayProxy = requireAddress(
    record.outputs.nativeBridgeGatewayProxy,
    "nativeBridgeGatewayProxy",
  );
  const nativeBridgeGatewayImplementation = requireAddress(
    record.outputs.nativeBridgeGatewayImplementation,
    "nativeBridgeGatewayImplementation",
  );
  const nativeBridgeGatewayProxyAdmin = requireAddress(
    record.outputs.nativeBridgeGatewayProxyAdmin,
    "nativeBridgeGatewayProxyAdmin",
  );
  const nativeVaultGateway = requireAddress(
    record.outputs.nativeVaultGateway,
    "nativeVaultGateway",
  );
  const timelock = requireAddress(
    record.outputs.yieldRecipientTimelockController,
    "yieldRecipientTimelockController",
  );

  const resolved = record.inputs.resolvedParams;

  renderSection("Record Expectations");
  await runCheck(results, "record targets mainnet production", () => {
    assertStringEqual(record.environment, "production", "environment");
    assertStringEqual(record.network, "mainnet", "network");
    if (chainId !== 1) {
      throw new Error(`connected chain id must be 1, got ${chainId}`);
    }
    return `record=${record.recordId}`;
  });

  await runCheck(
    results,
    "bootstrap and final authority addresses match the plan",
    () => {
      assertAddressEqual(
        requireAddress(record.actor.signer, "actor.signer"),
        EXPECTED_BOOTSTRAP_DEPLOYER,
        "record actor.signer",
      );
      assertAddressEqual(
        requireAddress(
          record.actor.longLivedAuthority,
          "actor.longLivedAuthority",
        ),
        EXPECTED_FINAL_VAULT_ADMIN,
        "record actor.longLivedAuthority",
      );
      assertAddressEqual(
        requireAddress(
          resolved.productionAuthorityPlan.bootstrapVaultAdmin,
          "productionAuthorityPlan.bootstrapVaultAdmin",
        ),
        EXPECTED_BOOTSTRAP_DEPLOYER,
        "productionAuthorityPlan.bootstrapVaultAdmin",
      );
      assertAddressEqual(
        requireAddress(
          resolved.productionAuthorityPlan.finalVaultAdmin,
          "productionAuthorityPlan.finalVaultAdmin",
        ),
        EXPECTED_FINAL_VAULT_ADMIN,
        "productionAuthorityPlan.finalVaultAdmin",
      );
      return `bootstrap=${EXPECTED_BOOTSTRAP_DEPLOYER} final=${EXPECTED_FINAL_VAULT_ADMIN}`;
    },
  );

  await runCheck(
    results,
    "fixed production addresses in the record match the expected set",
    () => {
      assertAddressEqual(
        requireAddress(resolved.vaultCore.bridgeHub, "vaultCore.bridgeHub"),
        EXPECTED_L1_BRIDGE_HUB,
        "vaultCore.bridgeHub",
      );
      assertAddressEqual(
        requireAddress(
          resolved.vaultCore.grvtBridgeProxyFeeToken,
          "vaultCore.grvtBridgeProxyFeeToken",
        ),
        EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN,
        "vaultCore.grvtBridgeProxyFeeToken",
      );
      assertAddressEqual(
        requireAddress(
          resolved.vaultCore.wrappedNativeToken,
          "vaultCore.wrappedNativeToken",
        ),
        EXPECTED_WRAPPED_NATIVE_TOKEN,
        "vaultCore.wrappedNativeToken",
      );
      assertAddressEqual(
        requireAddress(
          resolved.vaultCore.yieldRecipient,
          "vaultCore.yieldRecipient",
        ),
        EXPECTED_TREASURY_RECIPIENT,
        "vaultCore.yieldRecipient",
      );
      assertAddressEqual(
        requireAddress(
          resolved.vaultCore.l2ExchangeRecipient,
          "vaultCore.l2ExchangeRecipient",
        ),
        EXPECTED_L2_EXCHANGE_RECIPIENT,
        "vaultCore.l2ExchangeRecipient",
      );
      assertBigIntEqual(
        parseBigIntText(resolved.vaultCore.l2ChainId, "vaultCore.l2ChainId"),
        EXPECTED_L2_CHAIN_ID,
        "vaultCore.l2ChainId",
      );
      assertAddressEqual(
        requireAddress(resolved.strategyCore.aavePool, "strategyCore.aavePool"),
        EXPECTED_AAVE_V3_POOL,
        "strategyCore.aavePool",
      );
      assertAddressEqual(
        requireAddress(
          resolved.strategyCore.underlyingToken,
          "strategyCore.underlyingToken",
        ),
        EXPECTED_USDT,
        "strategyCore.underlyingToken",
      );
      assertAddressEqual(
        requireAddress(resolved.strategyCore.aToken, "strategyCore.aToken"),
        EXPECTED_AUSDT,
        "strategyCore.aToken",
      );
      assertStringEqual(
        resolved.strategyCore.strategyName,
        EXPECTED_STRATEGY_NAME,
        "strategyCore.strategyName",
      );
      return `bridgeHub=${EXPECTED_L1_BRIDGE_HUB} pool=${EXPECTED_AAVE_V3_POOL}`;
    },
  );

  renderSection("Contract Presence");
  for (const [label, address] of [
    ["vault implementation", vaultImplementation],
    ["vault proxy", vaultProxy],
    ["vault ProxyAdmin", vaultProxyAdmin],
    ["strategy implementation", strategyImplementation],
    ["strategy proxy", strategyProxy],
    ["strategy ProxyAdmin", strategyProxyAdmin],
    ["native vault gateway", nativeVaultGateway],
    ["native bridge gateway implementation", nativeBridgeGatewayImplementation],
    ["native bridge gateway proxy", nativeBridgeGatewayProxy],
    ["native bridge gateway ProxyAdmin", nativeBridgeGatewayProxyAdmin],
    ["yield recipient timelock", timelock],
    ["BridgeHub", EXPECTED_L1_BRIDGE_HUB],
    ["GRVT fee token", EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN],
    ["WETH", EXPECTED_WRAPPED_NATIVE_TOKEN],
    ["Aave pool", EXPECTED_AAVE_V3_POOL],
    ["USDT", EXPECTED_USDT],
    ["aUSDT", EXPECTED_AUSDT],
  ] as const) {
    await runCheck(results, `${label} is deployed`, async () => {
      await requireDeployedContract(publicClient, address, label);
      return address;
    });
  }

  renderSection("EOA and Safe Checks");
  for (const [label, address] of [
    ["bootstrap deployer", EXPECTED_BOOTSTRAP_DEPLOYER],
    ["Haoze operator", EXPECTED_HAOZE_OPERATOR],
    ["Minh operator", EXPECTED_MINH_OPERATOR],
    ["Aaron operator", EXPECTED_AARON_OPERATOR],
  ] as const) {
    await runCheck(results, `${label} is an EOA`, async () => {
      await requireEoa(publicClient, address, label);
      return address;
    });
  }

  await runCheck(results, "final vault admin is a 2-of-3 Safe", async () => {
    await requireDeployedContract(
      publicClient,
      EXPECTED_FINAL_VAULT_ADMIN,
      "final vault admin Safe",
    );
    const [owners, threshold] = await Promise.all([
      publicClient.readContract({
        address: EXPECTED_FINAL_VAULT_ADMIN,
        abi: safeAbi,
        functionName: "getOwners",
      }),
      publicClient.readContract({
        address: EXPECTED_FINAL_VAULT_ADMIN,
        abi: safeAbi,
        functionName: "getThreshold",
      }),
    ]);
    assertBigIntEqual(threshold, EXPECTED_SAFE_THRESHOLD, "safe threshold");
    assertTrue(
      owners.length === EXPECTED_SAFE_OWNER_COUNT,
      `safe owner count must be ${EXPECTED_SAFE_OWNER_COUNT}, got ${owners.length}`,
    );
    return `threshold=${threshold} owners=${owners.join(", ")}`;
  });

  const treasuryRecipientCode = await publicClient.getBytecode({
    address: EXPECTED_TREASURY_RECIPIENT,
  });
  if (treasuryRecipientCode === undefined || treasuryRecipientCode === "0x") {
    pushWarning(
      warnings,
      "treasury recipient has no code on L1",
      `${EXPECTED_TREASURY_RECIPIENT} currently has no deployed bytecode. The verifier still treats the vault config address as the source of truth.`,
    );
  } else {
    pushWarning(
      warnings,
      "treasury recipient has code on L1",
      `${EXPECTED_TREASURY_RECIPIENT} is already deployed on L1.`,
    );
  }

  renderSection("Proxy Wiring");
  for (const [label, proxy, expectedAdmin, expectedImplementation] of [
    ["vault proxy", vaultProxy, vaultProxyAdmin, vaultImplementation],
    [
      "strategy proxy",
      strategyProxy,
      strategyProxyAdmin,
      strategyImplementation,
    ],
    [
      "native bridge gateway proxy",
      nativeBridgeGatewayProxy,
      nativeBridgeGatewayProxyAdmin,
      nativeBridgeGatewayImplementation,
    ],
  ] as const) {
    await runCheck(
      results,
      `${label} admin slot matches the recorded ProxyAdmin`,
      async () => {
        const actualAdmin = await readProxyAdminAddress(publicClient, proxy);
        assertAddressEqual(actualAdmin, expectedAdmin, `${label} admin slot`);
        return actualAdmin;
      },
    );

    await runCheck(
      results,
      `${label} implementation slot matches the recorded implementation`,
      async () => {
        const actualImplementation = await readProxyImplementationAddress(
          publicClient,
          proxy,
        );
        assertAddressEqual(
          actualImplementation,
          expectedImplementation,
          `${label} implementation slot`,
        );
        return actualImplementation;
      },
    );
  }

  for (const [label, proxyAdmin] of [
    ["vault ProxyAdmin", vaultProxyAdmin],
    ["strategy ProxyAdmin", strategyProxyAdmin],
    ["native bridge gateway ProxyAdmin", nativeBridgeGatewayProxyAdmin],
  ] as const) {
    await runCheck(
      results,
      `${label} owner is the engineering Safe`,
      async () => {
        const owner = await publicClient.readContract({
          address: proxyAdmin,
          abi: proxyAdminAbi,
          functionName: "owner",
        });
        const normalizedOwner = getAddress(owner);
        assertAddressEqual(
          normalizedOwner,
          EXPECTED_FINAL_VAULT_ADMIN,
          `${label} owner`,
        );
        return normalizedOwner;
      },
    );
  }

  renderSection("Live Contract Configuration");
  await runCheck(
    results,
    "vault live config matches the expected fixed addresses",
    async () => {
      const [
        bridgeHub,
        feeToken,
        l2ChainId,
        l2ExchangeRecipient,
        wrappedNativeToken,
        nativeBridgeGateway,
        yieldRecipient,
        yieldRecipientTimelockController,
      ] = await Promise.all([
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "bridgeHub",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "grvtBridgeProxyFeeToken",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "l2ChainId",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "l2ExchangeRecipient",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "wrappedNativeToken",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "nativeBridgeGateway",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "yieldRecipient",
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: vaultConfigAbi,
          functionName: "yieldRecipientTimelockController",
        }),
      ]);

      assertAddressEqual(
        getAddress(bridgeHub),
        EXPECTED_L1_BRIDGE_HUB,
        "vault.bridgeHub",
      );
      assertAddressEqual(
        getAddress(feeToken),
        EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN,
        "vault.grvtBridgeProxyFeeToken",
      );
      assertBigIntEqual(l2ChainId, EXPECTED_L2_CHAIN_ID, "vault.l2ChainId");
      assertAddressEqual(
        getAddress(l2ExchangeRecipient),
        EXPECTED_L2_EXCHANGE_RECIPIENT,
        "vault.l2ExchangeRecipient",
      );
      assertAddressEqual(
        getAddress(wrappedNativeToken),
        EXPECTED_WRAPPED_NATIVE_TOKEN,
        "vault.wrappedNativeToken",
      );
      assertAddressEqual(
        getAddress(nativeBridgeGateway),
        nativeBridgeGatewayProxy,
        "vault.nativeBridgeGateway",
      );
      assertAddressEqual(
        getAddress(yieldRecipient),
        EXPECTED_TREASURY_RECIPIENT,
        "vault.yieldRecipient",
      );
      assertAddressEqual(
        getAddress(yieldRecipientTimelockController),
        timelock,
        "vault.yieldRecipientTimelockController",
      );
      return `vault=${vaultProxy}`;
    },
  );

  await runCheck(
    results,
    "strategy live config matches the expected Aave wiring",
    async () => {
      const [vault, aavePool, underlying, aToken, name] = await Promise.all([
        publicClient.readContract({
          address: strategyProxy,
          abi: strategyAbi,
          functionName: "vault",
        }),
        publicClient.readContract({
          address: strategyProxy,
          abi: strategyAbi,
          functionName: "aavePool",
        }),
        publicClient.readContract({
          address: strategyProxy,
          abi: strategyAbi,
          functionName: "underlying",
        }),
        publicClient.readContract({
          address: strategyProxy,
          abi: strategyAbi,
          functionName: "aToken",
        }),
        publicClient.readContract({
          address: strategyProxy,
          abi: strategyAbi,
          functionName: "name",
        }),
      ]);

      assertAddressEqual(getAddress(vault), vaultProxy, "strategy.vault");
      assertAddressEqual(
        getAddress(aavePool),
        EXPECTED_AAVE_V3_POOL,
        "strategy.aavePool",
      );
      assertAddressEqual(
        getAddress(underlying),
        EXPECTED_USDT,
        "strategy.underlying",
      );
      assertAddressEqual(getAddress(aToken), EXPECTED_AUSDT, "strategy.aToken");
      assertStringEqual(name, EXPECTED_STRATEGY_NAME, "strategy.name");
      return `strategy=${strategyProxy}`;
    },
  );

  await runCheck(
    results,
    "aUSDT linkage points to USDT and the shared Aave pool",
    async () => {
      const [underlyingAsset, pool] = await Promise.all([
        publicClient.readContract({
          address: EXPECTED_AUSDT,
          abi: aTokenAbi,
          functionName: "UNDERLYING_ASSET_ADDRESS",
        }),
        publicClient.readContract({
          address: EXPECTED_AUSDT,
          abi: aTokenAbi,
          functionName: "POOL",
        }),
      ]);
      assertAddressEqual(
        getAddress(underlyingAsset),
        EXPECTED_USDT,
        "aUSDT.UNDERLYING_ASSET_ADDRESS",
      );
      assertAddressEqual(getAddress(pool), EXPECTED_AAVE_V3_POOL, "aUSDT.POOL");
      return `aToken=${EXPECTED_AUSDT}`;
    },
  );

  await runCheck(
    results,
    "native bridge gateway live config matches the expected wiring",
    async () => {
      const [vault, wrappedNativeToken, feeToken, bridgeHub] =
        await Promise.all([
          publicClient.readContract({
            address: nativeBridgeGatewayProxy,
            abi: nativeBridgeGatewayAbi,
            functionName: "vault",
          }),
          publicClient.readContract({
            address: nativeBridgeGatewayProxy,
            abi: nativeBridgeGatewayAbi,
            functionName: "wrappedNativeToken",
          }),
          publicClient.readContract({
            address: nativeBridgeGatewayProxy,
            abi: nativeBridgeGatewayAbi,
            functionName: "grvtBridgeProxyFeeToken",
          }),
          publicClient.readContract({
            address: nativeBridgeGatewayProxy,
            abi: nativeBridgeGatewayAbi,
            functionName: "bridgeHub",
          }),
        ]);

      assertAddressEqual(
        getAddress(vault),
        vaultProxy,
        "nativeBridgeGateway.vault",
      );
      assertAddressEqual(
        getAddress(wrappedNativeToken),
        EXPECTED_WRAPPED_NATIVE_TOKEN,
        "nativeBridgeGateway.wrappedNativeToken",
      );
      assertAddressEqual(
        getAddress(feeToken),
        EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN,
        "nativeBridgeGateway.grvtBridgeProxyFeeToken",
      );
      assertAddressEqual(
        getAddress(bridgeHub),
        EXPECTED_L1_BRIDGE_HUB,
        "nativeBridgeGateway.bridgeHub",
      );
      return `gateway=${nativeBridgeGatewayProxy}`;
    },
  );

  renderSection("Role End State");
  const [
    defaultAdminRole,
    vaultAdminRole,
    allocatorRole,
    rebalancerRole,
    pauserRole,
  ] = await Promise.all([
    publicClient.readContract({
      address: vaultProxy,
      abi: accessControlAbi,
      functionName: "DEFAULT_ADMIN_ROLE",
    }),
    publicClient.readContract({
      address: vaultProxy,
      abi: vaultRoleAbi,
      functionName: "VAULT_ADMIN_ROLE",
    }),
    publicClient.readContract({
      address: vaultProxy,
      abi: vaultRoleAbi,
      functionName: "ALLOCATOR_ROLE",
    }),
    publicClient.readContract({
      address: vaultProxy,
      abi: vaultRoleAbi,
      functionName: "REBALANCER_ROLE",
    }),
    publicClient.readContract({
      address: vaultProxy,
      abi: vaultRoleAbi,
      functionName: "PAUSER_ROLE",
    }),
  ]);

  await runCheck(
    results,
    "final vault admin holds DEFAULT_ADMIN_ROLE and VAULT_ADMIN_ROLE",
    async () => {
      const [hasDefaultAdmin, hasVaultAdmin] = await Promise.all([
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [defaultAdminRole, EXPECTED_FINAL_VAULT_ADMIN],
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [vaultAdminRole, EXPECTED_FINAL_VAULT_ADMIN],
        }),
      ]);
      assertTrue(
        hasDefaultAdmin,
        "final vault admin is missing DEFAULT_ADMIN_ROLE",
      );
      assertTrue(
        hasVaultAdmin,
        "final vault admin is missing VAULT_ADMIN_ROLE",
      );
      return EXPECTED_FINAL_VAULT_ADMIN;
    },
  );

  await runCheck(
    results,
    "bootstrap deployer no longer holds retained vault authority",
    async () => {
      const [hasDefaultAdmin, hasVaultAdmin, hasPauser] = await Promise.all([
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [defaultAdminRole, EXPECTED_BOOTSTRAP_DEPLOYER],
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [vaultAdminRole, EXPECTED_BOOTSTRAP_DEPLOYER],
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [pauserRole, EXPECTED_BOOTSTRAP_DEPLOYER],
        }),
      ]);
      assertTrue(
        !hasDefaultAdmin,
        "bootstrap deployer still has DEFAULT_ADMIN_ROLE",
      );
      assertTrue(
        !hasVaultAdmin,
        "bootstrap deployer still has VAULT_ADMIN_ROLE",
      );
      assertTrue(!hasPauser, "bootstrap deployer still has PAUSER_ROLE");
      return EXPECTED_BOOTSTRAP_DEPLOYER;
    },
  );

  for (const [label, account] of [
    ["Haoze operator", EXPECTED_HAOZE_OPERATOR],
    ["Minh operator", EXPECTED_MINH_OPERATOR],
    ["Aaron operator", EXPECTED_AARON_OPERATOR],
  ] as const) {
    await runCheck(
      results,
      `${label} holds allocator/rebalancer/pauser`,
      async () => {
        const [hasAllocator, hasRebalancer, hasPauser] = await Promise.all([
          publicClient.readContract({
            address: vaultProxy,
            abi: accessControlAbi,
            functionName: "hasRole",
            args: [allocatorRole, account],
          }),
          publicClient.readContract({
            address: vaultProxy,
            abi: accessControlAbi,
            functionName: "hasRole",
            args: [rebalancerRole, account],
          }),
          publicClient.readContract({
            address: vaultProxy,
            abi: accessControlAbi,
            functionName: "hasRole",
            args: [pauserRole, account],
          }),
        ]);
        assertTrue(hasAllocator, `${label} is missing ALLOCATOR_ROLE`);
        assertTrue(hasRebalancer, `${label} is missing REBALANCER_ROLE`);
        assertTrue(hasPauser, `${label} is missing PAUSER_ROLE`);
        return account;
      },
    );
  }

  await runCheck(
    results,
    "vault holds MINTER_ROLE on the GRVT fee token",
    async () => {
      const minterRole = await publicClient.readContract({
        address: EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN,
        abi: feeTokenAbi,
        functionName: "MINTER_ROLE",
      });
      const hasRole = await publicClient.readContract({
        address: EXPECTED_GRVT_BRIDGE_PROXY_FEE_TOKEN,
        abi: feeTokenAbi,
        functionName: "hasRole",
        args: [minterRole, vaultProxy],
      });
      assertTrue(hasRole, "vault is missing MINTER_ROLE on the GRVT fee token");
      return vaultProxy;
    },
  );

  renderSection("Timelock End State");
  await runCheck(
    results,
    "yield recipient timelock admin and proposer match the engineering Safe",
    async () => {
      const [hasAdminRole, hasProposerRole] = await Promise.all([
        publicClient.readContract({
          address: timelock,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [TIMELOCK_ADMIN_ROLE, EXPECTED_FINAL_VAULT_ADMIN],
        }),
        publicClient.readContract({
          address: timelock,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [TIMELOCK_PROPOSER_ROLE, EXPECTED_FINAL_VAULT_ADMIN],
        }),
      ]);
      assertTrue(
        hasAdminRole,
        "engineering Safe is missing timelock admin role",
      );
      assertTrue(
        hasProposerRole,
        "engineering Safe is missing timelock proposer role",
      );
      return EXPECTED_FINAL_VAULT_ADMIN;
    },
  );

  for (const [label, account] of [
    ["Haoze operator", EXPECTED_HAOZE_OPERATOR],
    ["Minh operator", EXPECTED_MINH_OPERATOR],
    ["Aaron operator", EXPECTED_AARON_OPERATOR],
  ] as const) {
    await runCheck(results, `${label} is a timelock executor`, async () => {
      const hasExecutorRole = await publicClient.readContract({
        address: timelock,
        abi: accessControlAbi,
        functionName: "hasRole",
        args: [TIMELOCK_EXECUTOR_ROLE, account],
      });
      assertTrue(hasExecutorRole, `${label} is missing timelock executor role`);
      return account;
    });
  }

  renderSection("Summary");
  for (const result of results) {
    const prefix = result.ok ? chalk.green("PASS") : chalk.red("FAIL");
    console.log(
      `${prefix} ${result.label}${result.details === undefined ? "" : `: ${result.details}`}`,
    );
  }
  for (const warning of warnings) {
    console.log(`${chalk.yellow("WARN")} ${warning.label}: ${warning.details}`);
  }

  const failureCount = results.filter((result) => !result.ok).length;
  if (failureCount > 0) {
    console.error(chalk.red(`\n${failureCount} checks failed.`));
    process.exit(1);
  }

  console.log(chalk.green(`\nAll ${results.length} checks passed.`));
}

void main().catch((error) => {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});
