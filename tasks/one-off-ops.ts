import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { TaskDefinition } from "hardhat/types/tasks";

export const oneOffOpsTasks: TaskDefinition[] = [
  task("upgrade:vault", "Prepare or execute a vault upgrade")
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/vault-upgrade.js"))
    .build(),
  task("upgrade:vault:confirm", "Confirm a prepared vault upgrade")
    .addOption({
      name: "record",
      description:
        "Path to a prepared operation record directory or record.json",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .addOption({
      name: "txHash",
      description: "Executed proxy-admin upgrade transaction hash",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/vault-upgrade-confirm.js"))
    .build(),
  task("upgrade:strategy", "Prepare or execute a strategy upgrade")
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/strategy-upgrade.js"))
    .build(),
  task("upgrade:strategy:confirm", "Confirm a prepared strategy upgrade")
    .addOption({
      name: "record",
      description:
        "Path to a prepared operation record directory or record.json",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .addOption({
      name: "txHash",
      description: "Executed proxy-admin upgrade transaction hash",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .addOption({
      name: "strategyKey",
      description: "Strategy key expected in the resolved deployment state",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/strategy-upgrade-confirm.js"))
    .build(),
  task(
    "ops:production-admin-handoff",
    "Transfer production vault governance from the bootstrap signer to the final multisig",
  )
    .addOption({
      name: "record",
      description:
        "Path to the production initial-stack record directory or record.json",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .addOption({
      name: "allowBootstrapRoleRetention",
      description:
        "Allow the bootstrap signer to remain an operator or timelock holder",
      type: ArgumentType.FLAG,
      defaultValue: false,
    })
    .setAction(() => import("./actions/production-admin-handoff.js"))
    .build(),
  task("ops:allocate-to-strategy", "Allocate vault liquidity into a strategy")
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-allocate-to-strategy.js"))
    .build(),
  task(
    "ops:deallocate-from-strategy",
    "Deallocate part of a vault position from a strategy",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-deallocate-from-strategy.js"))
    .build(),
  task(
    "ops:deallocate-all-from-strategy",
    "Fully deallocate a vault position from a strategy",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-deallocate-all-from-strategy.js"))
    .build(),
  task(
    "ops:strategy-allocation-smoke",
    "Run the strategy allocation smoke flow against an existing deployment",
  )
    .addOption({
      name: "env",
      description: "Target environment: staging or testnet",
      type: ArgumentType.STRING,
      defaultValue: "staging",
    })
    .addOption({
      name: "strategyKey",
      description: "Strategy key to select from the resolved deployment state",
      type: ArgumentType.STRING,
      defaultValue: "primary",
    })
    .addOption({
      name: "record",
      description:
        "Optional operation record directory or record.json to use instead of latest env/network lookup",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .addOption({
      name: "amount",
      description: "Allocation amount, expressed in token units",
      type: ArgumentType.STRING,
      defaultValue: "10",
    })
    .addOption({
      name: "partialAmount",
      description: "Partial deallocation amount, expressed in token units",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .addOption({
      name: "dryRun",
      description: "Validate and print state without sending transactions",
      type: ArgumentType.FLAG,
      defaultValue: false,
    })
    .addOption({
      name: "fullUnwind",
      description: "Run the final deallocate-all step after the partial unwind",
      type: ArgumentType.BOOLEAN,
      defaultValue: true,
    })
    .setAction(() => import("./actions/ops-strategy-allocation-smoke.js"))
    .build(),
  task("ops:harvest-yield", "Harvest yield from an existing strategy")
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-harvest-yield.js"))
    .build(),
  task("ops:claim-gho-rewards", "Claim permissionless stkGHO rewards")
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-claim-gho-rewards.js"))
    .build(),
  task(
    "claim:failed-native-deposit",
    "Atomically claim and recover a failed native bridge deposit through NativeBridgeGateway",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/claim-failed-native-deposit.js"))
    .build(),
  task(
    "yield-recipient:schedule-update",
    "Schedule a yield-recipient timelock operation",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/yield-recipient-schedule-update.js"))
    .build(),
  task(
    "yield-recipient:execute-update",
    "Execute a scheduled yield-recipient timelock operation",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/yield-recipient-execute-update.js"))
    .build(),
];
