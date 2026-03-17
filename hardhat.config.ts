import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import HardhatContractSizer from "@solidstate/hardhat-contract-sizer";
import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";

const SOLIDITY_OPTIMIZER_SETTINGS = {
  enabled: true,
  runs: 200,
} as const;

const IGNITION_REQUIRED_CONFIRMATIONS =
  process.env.GRVT_ENV === "production" ? 5 : 1;

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, HardhatContractSizer],
  contractSizer: {
    strict: true,
    only: [/GRVTL1TreasuryVault/],
    runOnCompile: false,
    unit: "B",
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        settings: {
          optimizer: SOLIDITY_OPTIMIZER_SETTINGS,
        },
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: SOLIDITY_OPTIMIZER_SETTINGS,
        },
      },
    },
  },
  ignition: {
    requiredConfirmations: IGNITION_REQUIRED_CONFIRMATIONS,
  },
  networks: {
    default: {
      type: "edr-simulated",
      chainType: "l1",
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      // Hardhat node default dev key #0 (local smoke/CI only).
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ],
    },
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    hardhatTest: {
      type: "edr-simulated",
      chainType: "l1",
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
