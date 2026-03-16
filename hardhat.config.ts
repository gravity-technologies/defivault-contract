import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import HardhatContractSizer from "@solidstate/hardhat-contract-sizer";
import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";

/**
 * Central Hardhat configuration for local development, Ignition deployments,
 * and post-deploy verification.
 *
 * The only notable exception to the repo-wide Solidity version is for a small
 * set of packaged OpenZeppelin contracts that were deployed from upstream
 * artifacts and therefore must remain verifiable with their original compiler.
 */
const DEFAULT_SOLIDITY_VERSION = "0.8.34" as const;

/** Shared optimizer settings for project contracts and verification builds. */
const SOLIDITY_OPTIMIZER_SETTINGS = {
  enabled: true,
  runs: 200,
} as const;

/** Upstream OZ packaged artifacts in deployment flows were compiled with 0.8.27. */
const OPENZEPPELIN_PROXY_COMPILER_VERSION = "0.8.27" as const;

/** Etherscan verification is enabled only when the API key is present. */
const ETHERSCAN_ENABLED = process.env.ETHERSCAN_API_KEY !== undefined;

/** Hardhat node default dev account #0, used only for localhost workflows. */
const LOCALHOST_DEV_ACCOUNT =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Default compiler configuration for this repository's own Solidity sources. */
const DEFAULT_COMPILER = {
  version: DEFAULT_SOLIDITY_VERSION,
  settings: {
    optimizer: { ...SOLIDITY_OPTIMIZER_SETTINGS },
  },
};

/** Compiler override used for packaged OZ contracts that must verify as-deployed. */
const OPENZEPPELIN_PROXY_OVERRIDE = {
  version: OPENZEPPELIN_PROXY_COMPILER_VERSION,
  settings: {
    optimizer: { ...SOLIDITY_OPTIMIZER_SETTINGS },
  },
};

/** Source-level compiler overrides for packaged OZ contracts used by deployment tooling. */
const OPENZEPPELIN_PROXY_SOURCE_OVERRIDES = {
  "@openzeppelin/contracts/governance/TimelockController.sol":
    OPENZEPPELIN_PROXY_OVERRIDE,
  "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol":
    OPENZEPPELIN_PROXY_OVERRIDE,
  "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol":
    OPENZEPPELIN_PROXY_OVERRIDE,
};

/** Explicit npm sources that Hardhat must build so packaged OZ contracts can be verified. */
const OPENZEPPELIN_PROXY_NPM_FILES_TO_BUILD = [
  "@openzeppelin/contracts/governance/TimelockController.sol",
  "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
  "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
] as const;

/** Shared Solidity build profiles for normal and production-oriented Hardhat runs. */
const SOLIDITY_PROFILES = {
  default: {
    compilers: [{ ...DEFAULT_COMPILER }],
    overrides: OPENZEPPELIN_PROXY_SOURCE_OVERRIDES,
  },
  production: {
    compilers: [{ ...DEFAULT_COMPILER }],
    overrides: OPENZEPPELIN_PROXY_SOURCE_OVERRIDES,
  },
};

/** Verification provider configuration, defaulting to Sourcify when Etherscan is unavailable. */
const VERIFY_CONFIG = ETHERSCAN_ENABLED
  ? {
      etherscan: {
        apiKey: configVariable("ETHERSCAN_API_KEY"),
      },
      sourcify: {
        enabled: true,
      },
    }
  : {
      etherscan: {
        enabled: false as const,
      },
      sourcify: {
        enabled: true,
      },
    };

/** Shared simulated L1 network config used by multiple local/test Hardhat networks. */
const EDR_L1_NETWORK = {
  type: "edr-simulated",
  chainType: "l1",
} as const;

/** Production deployments wait longer for confirmations before Ignition proceeds. */
const IGNITION_REQUIRED_CONFIRMATIONS =
  process.env.GRVT_ENV === "production" ? 5 : 1;

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, HardhatContractSizer],
  // Guard vault bytecode growth during development and review.
  contractSizer: {
    strict: true,
    only: [/GRVTL1TreasuryVault/],
    runOnCompile: false,
    unit: "B",
  },
  // Compile repo contracts with 0.8.34, while retaining explicit OZ overrides
  // for packaged artifacts that must verify against their original bytecode.
  solidity: {
    npmFilesToBuild: [...OPENZEPPELIN_PROXY_NPM_FILES_TO_BUILD],
    profiles: SOLIDITY_PROFILES,
  },
  // Remote environments wait for confirmations before each Ignition step settles.
  ignition: {
    requiredConfirmations: IGNITION_REQUIRED_CONFIRMATIONS,
  },
  // Verification prefers Etherscan when configured and otherwise falls back to Sourcify.
  verify: VERIFY_CONFIG,
  networks: {
    default: EDR_L1_NETWORK,
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      // Hardhat node default dev key #0 (local smoke/CI only).
      accounts: [LOCALHOST_DEV_ACCOUNT],
    },
    hardhatMainnet: EDR_L1_NETWORK,
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    hardhatTest: {
      ...EDR_L1_NETWORK,
      // Test-only convenience: vault mock suites deploy oversized contracts.
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("TESTNET_RPC_URL"),
      accounts: [configVariable("TESTNET_PRIVATE_KEY")],
    },
  },
});
