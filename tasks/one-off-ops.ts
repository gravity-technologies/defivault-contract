import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { TaskDefinition } from "hardhat/types/tasks";

export const oneOffOpsTasks: TaskDefinition[] = [
  task("upgrade:vault", "Prepare or execute a vault upgrade")
    .addOption({
      name: "parameters",
      description: "Path to ignition-style JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/vault-upgrade.js"))
    .build(),
  task("ops:harvest-yield", "Harvest yield from an existing strategy")
    .addOption({
      name: "parameters",
      description: "Path to ignition-style JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-harvest-yield.js"))
    .build(),
  task(
    "claim:failed-native-deposit",
    "Atomically claim and recover a failed native bridge deposit through NativeBridgeGateway",
  )
    .addOption({
      name: "parameters",
      description: "Path to ignition-style JSON5 parameters file",
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
      description: "Path to ignition-style JSON5 parameters file",
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
      description: "Path to ignition-style JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/yield-recipient-execute-update.js"))
    .build(),
];
