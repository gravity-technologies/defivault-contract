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
  task(
    "ops:strategy-allocation-smoke",
    "Run the strategy allocation smoke flow against an existing deployment",
  )
    .addOption({
      name: "env",
      description: "Target environment: staging, testnet, or all",
      type: ArgumentType.STRING,
      defaultValue: "all",
    })
    .addOption({
      name: "strategyKey",
      description: "Strategy key to select from the deployment registry",
      type: ArgumentType.STRING,
      defaultValue: "primary",
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
      name: "skipMint",
      description: "Skip the vault mint step before allocation",
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
      description: "Path to ignition-style JSON5 parameters file",
      type: ArgumentType.FILE_WITHOUT_DEFAULT,
      defaultValue: undefined,
    })
    .setAction(() => import("./actions/ops-harvest-yield.js"))
    .build(),
  task(
    "claim:failed-native-deposit",
    "Claim a failed native bridge deposit and recover it through NativeBridgeGateway",
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
