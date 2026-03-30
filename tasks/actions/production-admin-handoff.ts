import type { NewTaskActionFunction } from "hardhat/types/tasks";
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
  operationRecordDir,
  readOperationRecord,
  repoRelativePath,
  writeOperationRecord,
  makeRecordId,
  nowIso,
  type OperationRecord,
  type OperationStep,
} from "../../scripts/deploy/operation-records.js";
import { getClients } from "../utils/one-off-ops.js";
import { proxyAdminAbi, readProxyAdminAddress } from "../utils/proxy-admin.js";

type ProductionAdminHandoffTaskArgs = {
  allowBootstrapRoleRetention?: boolean;
  record?: string;
};

type InitialStackRecord = OperationRecord & {
  inputs: {
    resolvedParams: {
      productionAuthorityPlan?: {
        bootstrapVaultAdmin: Address;
        finalVaultAdmin: Address;
      };
      rolesBootstrap: {
        allocator: Address;
        pauser: Address;
        rebalancer: Address;
      };
      yieldRecipientBootstrap: {
        admin: Address;
        executors: Address[];
        proposers: Address[];
      };
    };
  };
  steps: OperationStep[];
};

const accessControlAbi = parseAbi([
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function grantRole(bytes32 role,address account)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function renounceRole(bytes32 role,address callerConfirmation)",
]);
const vaultRoleAbi = parseAbi([
  "function VAULT_ADMIN_ROLE() view returns (bytes32)",
  "function REBALANCER_ROLE() view returns (bytes32)",
  "function ALLOCATOR_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
]);

const TIMELOCK_ADMIN_ROLE = zeroHash;
const TIMELOCK_PROPOSER_ROLE = keccak256(stringToHex("PROPOSER_ROLE"));
const TIMELOCK_EXECUTOR_ROLE = keccak256(stringToHex("EXECUTOR_ROLE"));

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function readInitialStackRecord(recordPathOrDir: string): InitialStackRecord {
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
    throw new Error(
      `initial-stack record ${record.recordId} is missing resolvedParams`,
    );
  }
  if (!Array.isArray(record.steps)) {
    throw new Error(
      `initial-stack record ${record.recordId} is missing step metadata`,
    );
  }
  return record as InitialStackRecord;
}

function stepAddresses(
  record: InitialStackRecord,
  stepLabel: string,
): Record<string, string> {
  const step = record.steps.find((candidate) => candidate.label === stepLabel);
  if (step?.addresses === undefined) {
    throw new Error(`missing recorded addresses for ${stepLabel}`);
  }
  return step.addresses;
}

function requireAddressString(
  addresses: Record<string, string> | undefined,
  key: string,
  label: string,
): Address {
  const value = addresses?.[key];
  if (value === undefined || !isAddress(value)) {
    throw new Error(`missing ${label} address ${key}`);
  }
  return getAddress(value);
}

async function recordStepExecution(args: {
  execute?: () => Promise<Hex>;
  noteIfSatisfied: string;
  step: OperationStep;
  verifySatisfied: () => Promise<boolean>;
}): Promise<void> {
  if (await args.verifySatisfied()) {
    args.step.completedAt = nowIso();
    args.step.notes = [...(args.step.notes ?? []), args.noteIfSatisfied];
    args.step.status = "complete";
    return;
  }
  if (args.execute === undefined) {
    throw new Error(
      `expected ${args.step.label} to already be satisfied, but it was not`,
    );
  }
  const txHash = await args.execute();
  args.step.txHashes = [...(args.step.txHashes ?? []), txHash];
  if (!(await args.verifySatisfied())) {
    throw new Error(`${args.step.label} did not satisfy its postcondition`);
  }
  args.step.completedAt = nowIso();
  args.step.status = "complete";
}

const action: NewTaskActionFunction<ProductionAdminHandoffTaskArgs> = async (
  { allowBootstrapRoleRetention = false, record },
  hre,
) => {
  if (record === undefined) {
    throw new Error(
      "missing required --record <initial-stack record dir|record.json>",
    );
  }

  const repoRoot = hre.config.paths.root;
  const initialRecordDir = record.endsWith(".json")
    ? record.slice(0, -"/record.json".length)
    : record;
  const initialRecord = readInitialStackRecord(record);
  if (initialRecord.environment !== "production") {
    throw new Error("production-admin-handoff only supports production runs");
  }
  if (
    initialRecord.inputs.resolvedParams.productionAuthorityPlan === undefined
  ) {
    throw new Error(
      "initial-stack record is missing productionAuthorityPlan metadata",
    );
  }

  const bootstrapVaultAdmin = getAddress(
    initialRecord.inputs.resolvedParams.productionAuthorityPlan
      .bootstrapVaultAdmin,
  );
  const finalVaultAdmin = getAddress(
    initialRecord.inputs.resolvedParams.productionAuthorityPlan.finalVaultAdmin,
  );
  if (sameAddress(bootstrapVaultAdmin, finalVaultAdmin)) {
    throw new Error("bootstrapVaultAdmin must differ from finalVaultAdmin");
  }

  const vaultCoreAddresses = stepAddresses(
    initialRecord,
    "Vault core deployment",
  );
  const timelockAddresses = stepAddresses(
    initialRecord,
    "Yield recipient timelock bootstrap",
  );
  const vaultProxy = requireAddressString(
    vaultCoreAddresses,
    "vaultProxy",
    "vault core",
  );
  const timelock = requireAddressString(
    timelockAddresses,
    "yieldRecipientTimelockController",
    "yield recipient timelock",
  );

  const { publicClient, walletClient } = await getClients(hre);
  const signer = getAddress(walletClient.account.address);
  if (!sameAddress(signer, bootstrapVaultAdmin)) {
    throw new Error(
      `signer ${signer} must match bootstrap vault admin ${bootstrapVaultAdmin}`,
    );
  }

  const vaultProxyAdmin = await readProxyAdminAddress(publicClient, vaultProxy);
  const vaultDefaultAdminRole = await publicClient.readContract({
    address: vaultProxy,
    abi: accessControlAbi,
    functionName: "DEFAULT_ADMIN_ROLE",
  });
  const vaultAdminRole = await publicClient.readContract({
    address: vaultProxy,
    abi: vaultRoleAbi,
    functionName: "VAULT_ADMIN_ROLE",
  });
  const allocatorRole = await publicClient.readContract({
    address: vaultProxy,
    abi: vaultRoleAbi,
    functionName: "ALLOCATOR_ROLE",
  });
  const rebalancerRole = await publicClient.readContract({
    address: vaultProxy,
    abi: vaultRoleAbi,
    functionName: "REBALANCER_ROLE",
  });
  const pauserRole = await publicClient.readContract({
    address: vaultProxy,
    abi: vaultRoleAbi,
    functionName: "PAUSER_ROLE",
  });
  const expectedAllocator = getAddress(
    initialRecord.inputs.resolvedParams.rolesBootstrap.allocator,
  );
  const expectedRebalancer = getAddress(
    initialRecord.inputs.resolvedParams.rolesBootstrap.rebalancer,
  );
  const expectedPauser = getAddress(
    initialRecord.inputs.resolvedParams.rolesBootstrap.pauser,
  );
  const expectedTimelockAdmin = getAddress(
    initialRecord.inputs.resolvedParams.yieldRecipientBootstrap.admin,
  );
  const expectedTimelockProposers =
    initialRecord.inputs.resolvedParams.yieldRecipientBootstrap.proposers.map(
      (account) => getAddress(account),
    );
  const expectedTimelockExecutors =
    initialRecord.inputs.resolvedParams.yieldRecipientBootstrap.executors.map(
      (account) => getAddress(account),
    );

  if (!allowBootstrapRoleRetention) {
    const forbiddenAccounts = [
      expectedAllocator,
      expectedRebalancer,
      expectedPauser,
      expectedTimelockAdmin,
      ...expectedTimelockProposers,
      ...expectedTimelockExecutors,
    ];
    if (forbiddenAccounts.some((account) => sameAddress(account, signer))) {
      throw new Error(
        "bootstrap vault admin cannot remain an operator or timelock holder in production without --allowBootstrapRoleRetention",
      );
    }
  }

  const handoffRecordId = makeRecordId();
  const handoffDir = operationRecordDir({
    environment: initialRecord.environment,
    kind: "production-admin-handoff",
    network: initialRecord.network,
    recordId: handoffRecordId,
    repoRoot,
  });
  const handoffRecord: OperationRecord = {
    actor: {
      longLivedAuthority: finalVaultAdmin,
      signer,
    },
    chainId: initialRecord.chainId,
    createdAt: nowIso(),
    environment: initialRecord.environment,
    inputs: {
      allowBootstrapRoleRetention,
      bootstrapVaultAdmin,
      finalVaultAdmin,
      initialRecordId: initialRecord.recordId,
      timelock,
      vaultProxy,
      vaultProxyAdmin,
    },
    kind: "production-admin-handoff",
    links: [
      {
        kind: "initial-stack-record",
        path: repoRelativePath(
          repoRoot,
          initialRecordDir.endsWith(".json")
            ? initialRecordDir
            : `${initialRecordDir}/record.json`,
        ),
        recordId: initialRecord.recordId,
      },
    ],
    mode: "direct",
    network: initialRecord.network,
    outputs: {},
    recordId: handoffRecordId,
    schemaVersion: 1,
    status: "prepared",
    steps: [],
  };

  const persistHandoffRecord = () => {
    writeOperationRecord(handoffDir, handoffRecord);
  };

  const runStep = async (args: {
    execute?: () => Promise<Hex>;
    label: string;
    noteIfSatisfied: string;
    verifySatisfied: () => Promise<boolean>;
  }) => {
    const step: OperationStep = {
      label: args.label,
      startedAt: nowIso(),
      status: "prepared",
    };
    handoffRecord.steps = [...(handoffRecord.steps ?? []), step];
    persistHandoffRecord();
    try {
      await recordStepExecution({
        execute: args.execute,
        noteIfSatisfied: args.noteIfSatisfied,
        step,
        verifySatisfied: args.verifySatisfied,
      });
    } catch (error) {
      step.completedAt = nowIso();
      step.status = "failed";
      handoffRecord.status = "failed";
      persistHandoffRecord();
      throw error;
    }
    persistHandoffRecord();
  };

  await runStep({
    label: "Validate production final holders",
    noteIfSatisfied:
      "Production operator and timelock holders are distinct from the bootstrap signer.",
    verifySatisfied: async () => true,
  });

  await runStep({
    execute: async () =>
      walletClient.writeContract({
        abi: accessControlAbi,
        account: walletClient.account,
        address: vaultProxy,
        args: [vaultDefaultAdminRole, finalVaultAdmin],
        chain: walletClient.chain,
        functionName: "grantRole",
      }),
    label: "Grant DEFAULT_ADMIN_ROLE to final vault admin",
    noteIfSatisfied: "Final vault admin already held DEFAULT_ADMIN_ROLE.",
    verifySatisfied: async () =>
      publicClient.readContract({
        address: vaultProxy,
        abi: accessControlAbi,
        functionName: "hasRole",
        args: [vaultDefaultAdminRole, finalVaultAdmin],
      }),
  });

  await runStep({
    execute: async () =>
      walletClient.writeContract({
        abi: accessControlAbi,
        account: walletClient.account,
        address: vaultProxy,
        args: [vaultAdminRole, finalVaultAdmin],
        chain: walletClient.chain,
        functionName: "grantRole",
      }),
    label: "Grant VAULT_ADMIN_ROLE to final vault admin",
    noteIfSatisfied: "Final vault admin already held VAULT_ADMIN_ROLE.",
    verifySatisfied: async () =>
      publicClient.readContract({
        address: vaultProxy,
        abi: accessControlAbi,
        functionName: "hasRole",
        args: [vaultAdminRole, finalVaultAdmin],
      }),
  });

  await runStep({
    label: "Verify final operator-role holders",
    noteIfSatisfied:
      "Allocator, rebalancer, and pauser holders match the expected production plan.",
    verifySatisfied: async () => {
      const [allocatorOk, rebalancerOk, pauserOk] = await Promise.all([
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [allocatorRole, expectedAllocator],
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [rebalancerRole, expectedRebalancer],
        }),
        publicClient.readContract({
          address: vaultProxy,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [pauserRole, expectedPauser],
        }),
      ]);
      return allocatorOk && rebalancerOk && pauserOk;
    },
  });

  await runStep({
    label: "Verify timelock role holders",
    noteIfSatisfied:
      "Timelock admin, proposers, and executors match the expected production plan.",
    verifySatisfied: async () => {
      const [adminOk, proposerChecks, executorChecks] = await Promise.all([
        publicClient.readContract({
          address: timelock,
          abi: accessControlAbi,
          functionName: "hasRole",
          args: [TIMELOCK_ADMIN_ROLE, expectedTimelockAdmin],
        }),
        Promise.all(
          expectedTimelockProposers.map((account) =>
            publicClient.readContract({
              address: timelock,
              abi: accessControlAbi,
              functionName: "hasRole",
              args: [TIMELOCK_PROPOSER_ROLE, account],
            }),
          ),
        ),
        Promise.all(
          expectedTimelockExecutors.map((account) =>
            publicClient.readContract({
              address: timelock,
              abi: accessControlAbi,
              functionName: "hasRole",
              args: [TIMELOCK_EXECUTOR_ROLE, account],
            }),
          ),
        ),
      ]);
      return (
        adminOk &&
        proposerChecks.every(Boolean) &&
        executorChecks.every(Boolean)
      );
    },
  });

  await runStep({
    execute: async () =>
      walletClient.writeContract({
        abi: proxyAdminAbi,
        account: walletClient.account,
        address: vaultProxyAdmin,
        args: [finalVaultAdmin],
        chain: walletClient.chain,
        functionName: "transferOwnership",
      }),
    label: "Transfer vault ProxyAdmin ownership",
    noteIfSatisfied:
      "Vault ProxyAdmin already belongs to the final vault admin.",
    verifySatisfied: async () => {
      const owner = await publicClient.readContract({
        address: vaultProxyAdmin,
        abi: proxyAdminAbi,
        functionName: "owner",
      });
      return sameAddress(getAddress(owner), finalVaultAdmin);
    },
  });

  await runStep({
    execute: async () =>
      walletClient.writeContract({
        abi: accessControlAbi,
        account: walletClient.account,
        address: vaultProxy,
        args: [vaultAdminRole, signer],
        chain: walletClient.chain,
        functionName: "renounceRole",
      }),
    label: "Renounce VAULT_ADMIN_ROLE from bootstrap signer",
    noteIfSatisfied: "Bootstrap signer no longer holds VAULT_ADMIN_ROLE.",
    verifySatisfied: async () => {
      const hasRole = await publicClient.readContract({
        address: vaultProxy,
        abi: accessControlAbi,
        functionName: "hasRole",
        args: [vaultAdminRole, signer],
      });
      return !hasRole;
    },
  });

  await runStep({
    execute: async () =>
      walletClient.writeContract({
        abi: accessControlAbi,
        account: walletClient.account,
        address: vaultProxy,
        args: [pauserRole, signer],
        chain: walletClient.chain,
        functionName: "renounceRole",
      }),
    label: "Renounce PAUSER_ROLE from bootstrap signer",
    noteIfSatisfied: "Bootstrap signer no longer holds PAUSER_ROLE.",
    verifySatisfied: async () => {
      const hasRole = await publicClient.readContract({
        address: vaultProxy,
        abi: accessControlAbi,
        functionName: "hasRole",
        args: [pauserRole, signer],
      });
      return !hasRole;
    },
  });

  await runStep({
    execute: async () =>
      walletClient.writeContract({
        abi: accessControlAbi,
        account: walletClient.account,
        address: vaultProxy,
        args: [vaultDefaultAdminRole, signer],
        chain: walletClient.chain,
        functionName: "renounceRole",
      }),
    label: "Renounce DEFAULT_ADMIN_ROLE from bootstrap signer",
    noteIfSatisfied: "Bootstrap signer no longer holds DEFAULT_ADMIN_ROLE.",
    verifySatisfied: async () => {
      const hasRole = await publicClient.readContract({
        address: vaultProxy,
        abi: accessControlAbi,
        functionName: "hasRole",
        args: [vaultDefaultAdminRole, signer],
      });
      return !hasRole;
    },
  });

  await runStep({
    label: "Final no-retained-authority verification",
    noteIfSatisfied:
      "Bootstrap signer no longer controls the vault roles or ProxyAdmin.",
    verifySatisfied: async () => {
      const [defaultAdminRetained, vaultAdminRetained, pauserRetained, owner] =
        await Promise.all([
          publicClient.readContract({
            address: vaultProxy,
            abi: accessControlAbi,
            functionName: "hasRole",
            args: [vaultDefaultAdminRole, signer],
          }),
          publicClient.readContract({
            address: vaultProxy,
            abi: accessControlAbi,
            functionName: "hasRole",
            args: [vaultAdminRole, signer],
          }),
          publicClient.readContract({
            address: vaultProxy,
            abi: accessControlAbi,
            functionName: "hasRole",
            args: [pauserRole, signer],
          }),
          publicClient.readContract({
            address: vaultProxyAdmin,
            abi: proxyAdminAbi,
            functionName: "owner",
          }),
        ]);

      return (
        !defaultAdminRetained &&
        !vaultAdminRetained &&
        !pauserRetained &&
        sameAddress(getAddress(owner), finalVaultAdmin)
      );
    },
  });

  handoffRecord.outputs = {
    bootstrapVaultAdmin,
    finalVaultAdmin,
    vaultProxy,
    vaultProxyAdmin,
  };
  handoffRecord.status = "complete";
  persistHandoffRecord();

  initialRecord.links = [
    ...(initialRecord.links ?? []),
    {
      kind: "production-admin-handoff",
      path: repoRelativePath(repoRoot, `${handoffDir}/record.json`),
      recordId: handoffRecord.recordId,
    },
  ];
  initialRecord.status = "complete";
  writeOperationRecord(initialRecordDir, initialRecord);

  console.log(
    `recordPath=${repoRelativePath(repoRoot, `${handoffDir}/record.json`)}`,
  );
};

export default action;
