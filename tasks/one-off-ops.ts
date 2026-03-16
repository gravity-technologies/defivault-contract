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
  task("ops:harvest-yield", "Harvest yield from an existing strategy")
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-harvest-yield.js"))
    .build(),
  task(
    "ops:emergency-native-to-l2",
    "Trigger the vault emergency native bridge path to L2",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-emergency-native-to-l2.js"))
    .build(),
  task(
    "ops:emergency-erc20-to-l2",
    "Trigger the vault emergency ERC20 bridge path to L2",
  )
    .addOption({
      name: "parameters",
      description: "Path to JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-emergency-erc20-to-l2.js"))
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
