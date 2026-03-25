import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { encodeFunctionData, parseAbi } from "viem";

import {
  loadVerificationTargetsFromDeploymentDir,
  resolveVerificationTargets,
} from "../../scripts/verify/verify-v2-strategies.js";

const AAVE_V2_INITIALIZE_ABI = parseAbi([
  "function initialize(address vault,address aavePool,address vaultToken,address aToken,string strategyName)",
]);

const GHO_STRATEGY_INITIALIZE_ABI = parseAbi([
  "function initialize(address vault,address vaultToken,address gho,address stkGho,address gsm,address stkGhoStakingAdapter,address stkGhoRewardsDistributor,string strategyName)",
]);

function withDeploymentDir(args: {
  artifactFiles: Array<{ name: string; contractName: string }>;
  deployedAddresses: Record<string, string>;
  manifest: Record<string, unknown>;
  run: (deploymentDir: string) => void;
}) {
  const deploymentDir = mkdtempSync(
    join(tmpdir(), "verify-v2-strategies-test-"),
  );
  try {
    mkdirSync(join(deploymentDir, "artifacts"), { recursive: true });
    for (const artifact of args.artifactFiles) {
      writeFileSync(
        join(deploymentDir, "artifacts", artifact.name),
        JSON.stringify({ contractName: artifact.contractName }),
      );
    }
    writeFileSync(
      join(deploymentDir, "manifest.json"),
      JSON.stringify(args.manifest),
    );
    writeFileSync(
      join(deploymentDir, "deployed_addresses.json"),
      JSON.stringify(args.deployedAddresses),
    );
    args.run(deploymentDir);
  } finally {
    rmSync(deploymentDir, { recursive: true, force: true });
  }
}

describe("verify-v2-strategies helpers", function () {
  it("resolves Aave V2 family implementation and beacon targets", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2FamilyModule#StrategyV2Implementation.json",
          contractName: "AaveV3StrategyV2",
        },
      ],
      deployedAddresses: {
        "StrategyV2FamilyModule#StrategyV2Implementation":
          "0x1000000000000000000000000000000000000001",
        "StrategyV2FamilyModule#StrategyV2Beacon":
          "0x1000000000000000000000000000000000000002",
      },
      manifest: {
        network: { name: "sepolia" },
        resolvedParams: {
          StrategyV2FamilyModule: {
            beaconOwner: "0x1000000000000000000000000000000000000003",
          },
        },
      },
      run(deploymentDir) {
        const { network, targets } =
          loadVerificationTargetsFromDeploymentDir(deploymentDir);

        assert.equal(network, "sepolia");

        assert.deepEqual(targets, [
          {
            address: "0x1000000000000000000000000000000000000001",
            contract:
              "contracts/strategies/AaveV3StrategyV2.sol:AaveV3StrategyV2",
            constructorArgs: [],
            label: "Aave V2 implementation",
            slug: "aave-v2-implementation",
          },
          {
            address: "0x1000000000000000000000000000000000000002",
            contract:
              "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
            constructorArgs: [
              "0x1000000000000000000000000000000000000001",
              "0x1000000000000000000000000000000000000003",
            ],
            label: "Aave V2 beacon",
            slug: "aave-v2-beacon",
          },
        ]);
      },
    });
  });

  it("resolves GHO family implementation and beacon targets", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "GhoStrategyFamilyModule#GhoStrategyImplementation.json",
          contractName: "GsmStkGhoStrategy",
        },
      ],
      deployedAddresses: {
        "GhoStrategyFamilyModule#GhoStrategyImplementation":
          "0x2000000000000000000000000000000000000001",
        "GhoStrategyFamilyModule#GhoStrategyBeacon":
          "0x2000000000000000000000000000000000000002",
      },
      manifest: {
        network: { name: "sepolia" },
        resolvedParams: {
          GhoStrategyFamilyModule: {
            beaconOwner: "0x2000000000000000000000000000000000000003",
          },
        },
      },
      run(deploymentDir) {
        const { network, targets } =
          loadVerificationTargetsFromDeploymentDir(deploymentDir);

        assert.equal(network, "sepolia");

        assert.deepEqual(targets, [
          {
            address: "0x2000000000000000000000000000000000000001",
            contract:
              "contracts/strategies/GsmStkGhoStrategy.sol:GsmStkGhoStrategy",
            constructorArgs: [],
            label: "GHO strategy implementation",
            slug: "gho-strategy-implementation",
          },
          {
            address: "0x2000000000000000000000000000000000000002",
            contract:
              "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
            constructorArgs: [
              "0x2000000000000000000000000000000000000001",
              "0x2000000000000000000000000000000000000003",
            ],
            label: "GHO strategy beacon",
            slug: "gho-strategy-beacon",
          },
        ]);
      },
    });
  });

  it("resolves an Aave V2 lane proxy with encoded init calldata", function () {
    const expectedCalldata = encodeFunctionData({
      abi: AAVE_V2_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        "0x3000000000000000000000000000000000000001",
        "0x3000000000000000000000000000000000000002",
        "0x3000000000000000000000000000000000000003",
        "0x3000000000000000000000000000000000000004",
        "AAVE_V3_USDT_V2",
      ],
    });

    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2LaneModule#Strategy.json",
          contractName: "AaveV3StrategyV2",
        },
      ],
      deployedAddresses: {
        "StrategyV2LaneModule#StrategyV2Proxy":
          "0x3000000000000000000000000000000000000005",
      },
      manifest: {
        network: { name: "sepolia" },
        resolvedParams: {
          StrategyV2LaneModule: {
            strategyBeacon: "0x3000000000000000000000000000000000000006",
            vaultProxy: "0x3000000000000000000000000000000000000001",
            aavePool: "0x3000000000000000000000000000000000000002",
            vaultToken: "0x3000000000000000000000000000000000000003",
            aToken: "0x3000000000000000000000000000000000000004",
            strategyName: "AAVE_V3_USDT_V2",
          },
        },
      },
      run(deploymentDir) {
        const { network, targets } =
          loadVerificationTargetsFromDeploymentDir(deploymentDir);

        assert.equal(network, "sepolia");

        assert.deepEqual(targets, [
          {
            address: "0x3000000000000000000000000000000000000005",
            contract:
              "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy",
            constructorArgs: [
              "0x3000000000000000000000000000000000000006",
              expectedCalldata,
            ],
            label: "Aave V2 lane proxy",
            slug: "aave-v2-lane-proxy",
          },
        ]);
      },
    });
  });

  it("resolves a GHO lane proxy with encoded init calldata", function () {
    const expectedCalldata = encodeFunctionData({
      abi: GHO_STRATEGY_INITIALIZE_ABI,
      functionName: "initialize",
      args: [
        "0x4000000000000000000000000000000000000001",
        "0x4000000000000000000000000000000000000002",
        "0x4000000000000000000000000000000000000003",
        "0x4000000000000000000000000000000000000004",
        "0x4000000000000000000000000000000000000005",
        "0x4000000000000000000000000000000000000006",
        "0x4000000000000000000000000000000000000007",
        "GSM_STKGHO_USDC",
      ],
    });

    withDeploymentDir({
      artifactFiles: [
        {
          name: "GhoStrategyLaneModule#Strategy.json",
          contractName: "GsmStkGhoStrategy",
        },
      ],
      deployedAddresses: {
        "GhoStrategyLaneModule#GhoStrategyProxy":
          "0x4000000000000000000000000000000000000008",
      },
      manifest: {
        network: { name: "sepolia" },
        resolvedParams: {
          GhoStrategyLaneModule: {
            strategyBeacon: "0x4000000000000000000000000000000000000009",
            vaultProxy: "0x4000000000000000000000000000000000000001",
            vaultToken: "0x4000000000000000000000000000000000000002",
            ghoToken: "0x4000000000000000000000000000000000000003",
            stkGhoToken: "0x4000000000000000000000000000000000000004",
            gsmAdapter: "0x4000000000000000000000000000000000000005",
            stkGhoStakingAdapter: "0x4000000000000000000000000000000000000006",
            stkGhoRewardsDistributor:
              "0x4000000000000000000000000000000000000007",
            strategyName: "GSM_STKGHO_USDC",
          },
        },
      },
      run(deploymentDir) {
        const { network, targets } =
          loadVerificationTargetsFromDeploymentDir(deploymentDir);

        assert.equal(network, "sepolia");

        assert.deepEqual(targets, [
          {
            address: "0x4000000000000000000000000000000000000008",
            contract:
              "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy",
            constructorArgs: [
              "0x4000000000000000000000000000000000000009",
              expectedCalldata,
            ],
            label: "GHO lane proxy",
            slug: "gho-lane-proxy",
          },
        ]);
      },
    });
  });

  it("fails cleanly when a known family deployment is missing required ids", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2FamilyModule#StrategyV2Implementation.json",
          contractName: "AaveV3StrategyV2",
        },
      ],
      deployedAddresses: {},
      manifest: {
        network: { name: "sepolia" },
        resolvedParams: {
          StrategyV2FamilyModule: {
            beaconOwner: "0x5000000000000000000000000000000000000001",
          },
        },
      },
      run(deploymentDir) {
        assert.throws(
          () =>
            resolveVerificationTargets(
              deploymentDir,
              {
                resolvedParams: {
                  StrategyV2FamilyModule: {
                    beaconOwner: "0x5000000000000000000000000000000000000001",
                  },
                },
              },
              {},
            ),
          /missing Aave V2 family deployment data/,
        );
      },
    });
  });

  it("fails cleanly when the deployment dir does not match a known V2 shape", function () {
    withDeploymentDir({
      artifactFiles: [],
      deployedAddresses: {},
      manifest: { resolvedParams: {} },
      run(deploymentDir) {
        assert.throws(
          () =>
            resolveVerificationTargets(
              deploymentDir,
              { resolvedParams: {} },
              {},
            ),
          /could not identify a V2 beacon deployment/,
        );
      },
    });
  });

  it("fails cleanly when the deployment manifest is missing network.name", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2FamilyModule#StrategyV2Implementation.json",
          contractName: "AaveV3StrategyV2",
        },
      ],
      deployedAddresses: {
        "StrategyV2FamilyModule#StrategyV2Implementation":
          "0x6000000000000000000000000000000000000001",
        "StrategyV2FamilyModule#StrategyV2Beacon":
          "0x6000000000000000000000000000000000000002",
      },
      manifest: {
        resolvedParams: {
          StrategyV2FamilyModule: {
            beaconOwner: "0x6000000000000000000000000000000000000003",
          },
        },
      },
      run(deploymentDir) {
        assert.throws(
          () => loadVerificationTargetsFromDeploymentDir(deploymentDir),
          /deployment manifest is missing network.name/,
        );
      },
    });
  });

  it("fails cleanly when both family artifacts are present", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2FamilyModule#StrategyV2Implementation.json",
          contractName: "AaveV3StrategyV2",
        },
        {
          name: "GhoStrategyFamilyModule#GhoStrategyImplementation.json",
          contractName: "GsmStkGhoStrategy",
        },
      ],
      deployedAddresses: {},
      manifest: { resolvedParams: {} },
      run(deploymentDir) {
        assert.throws(
          () =>
            resolveVerificationTargets(
              deploymentDir,
              { resolvedParams: {} },
              {},
            ),
          /ambiguous V2 family deployment/,
        );
      },
    });
  });

  it("fails cleanly when both lane proxies are present", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2LaneModule#Strategy.json",
          contractName: "AaveV3StrategyV2",
        },
      ],
      deployedAddresses: {
        "StrategyV2LaneModule#StrategyV2Proxy":
          "0x7000000000000000000000000000000000000001",
        "GhoStrategyLaneModule#GhoStrategyProxy":
          "0x7000000000000000000000000000000000000002",
      },
      manifest: {
        resolvedParams: {
          StrategyV2LaneModule: {
            strategyBeacon: "0x7000000000000000000000000000000000000003",
            vaultProxy: "0x7000000000000000000000000000000000000004",
            aavePool: "0x7000000000000000000000000000000000000005",
            vaultToken: "0x7000000000000000000000000000000000000006",
            aToken: "0x7000000000000000000000000000000000000007",
            strategyName: "AAVE_V3_USDT_V2",
          },
        },
      },
      run(deploymentDir) {
        assert.throws(
          () =>
            resolveVerificationTargets(
              deploymentDir,
              {
                resolvedParams: {
                  StrategyV2LaneModule: {
                    strategyBeacon:
                      "0x7000000000000000000000000000000000000003",
                    vaultProxy: "0x7000000000000000000000000000000000000004",
                    aavePool: "0x7000000000000000000000000000000000000005",
                    vaultToken: "0x7000000000000000000000000000000000000006",
                    aToken: "0x7000000000000000000000000000000000000007",
                    strategyName: "AAVE_V3_USDT_V2",
                  },
                },
              },
              {
                "StrategyV2LaneModule#StrategyV2Proxy":
                  "0x7000000000000000000000000000000000000001",
                "GhoStrategyLaneModule#GhoStrategyProxy":
                  "0x7000000000000000000000000000000000000002",
              },
            ),
          /ambiguous V2 lane deployment/,
        );
      },
    });
  });

  it("fails cleanly when both family and lane targets are present in one deployment dir", function () {
    withDeploymentDir({
      artifactFiles: [
        {
          name: "StrategyV2FamilyModule#StrategyV2Implementation.json",
          contractName: "AaveV3StrategyV2",
        },
        {
          name: "StrategyV2LaneModule#Strategy.json",
          contractName: "AaveV3StrategyV2",
        },
      ],
      deployedAddresses: {
        "StrategyV2FamilyModule#StrategyV2Implementation":
          "0x8000000000000000000000000000000000000001",
        "StrategyV2FamilyModule#StrategyV2Beacon":
          "0x8000000000000000000000000000000000000002",
        "StrategyV2LaneModule#StrategyV2Proxy":
          "0x8000000000000000000000000000000000000003",
      },
      manifest: {
        network: { name: "sepolia" },
        resolvedParams: {
          StrategyV2FamilyModule: {
            beaconOwner: "0x8000000000000000000000000000000000000004",
          },
          StrategyV2LaneModule: {
            strategyBeacon: "0x8000000000000000000000000000000000000002",
            vaultProxy: "0x8000000000000000000000000000000000000005",
            aavePool: "0x8000000000000000000000000000000000000006",
            vaultToken: "0x8000000000000000000000000000000000000007",
            aToken: "0x8000000000000000000000000000000000000008",
            strategyName: "AAVE_V3_USDT_V2",
          },
        },
      },
      run(deploymentDir) {
        assert.throws(
          () => loadVerificationTargetsFromDeploymentDir(deploymentDir),
          /deployment dir is ambiguous: found both family and lane verification targets/,
        );
      },
    });
  });
});
