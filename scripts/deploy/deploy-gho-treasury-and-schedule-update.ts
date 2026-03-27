import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import { parseAddress, readJson5Object, readParametersPath } from "./shared.js";

type ReimbursementConfig = {
  strategy: Address;
  token: Address;
  enabled: boolean;
  remainingBudget: bigint;
};

type SeedFunding = {
  token: Address;
  amount: bigint;
};

type TreasuryScheduleParams = {
  vaultProxy: Address;
  yieldRecipientTimelockController: Address;
  treasuryBootstrapOwner?: Address;
  treasuryFinalOwner?: Address;
  authorizeVault: boolean;
  reimbursementConfigs: ReimbursementConfig[];
  seedFunding: SeedFunding[];
  predecessor: Hex;
  salt: Hex;
  delay: bigint;
};

const zeroHash =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const timelockAbi = parseAbi([
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
]);

const erc20Abi = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
]);

function parseOptionalAddress(
  value: unknown,
  label: string,
): Address | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseAddress(value, label);
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`invalid ${label}: expected boolean`);
}

function parseBytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) {
    throw new Error(`invalid ${label}: expected bytes32 hex string`);
  }
  return value as Hex;
}

function parseBigintLike(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n)
      throw new Error(`invalid ${label}: expected non-negative bigint`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid ${label}: expected non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const normalized = value.endsWith("n") ? value.slice(0, -1) : value;
    let parsed: bigint;
    try {
      parsed = BigInt(normalized);
    } catch {
      throw new Error(`invalid ${label}: expected bigint-compatible value`);
    }
    if (parsed < 0n) {
      throw new Error(`invalid ${label}: expected non-negative bigint`);
    }
    return parsed;
  }
  throw new Error(`invalid ${label}: expected bigint-compatible value`);
}

function readParams(filePath: string): TreasuryScheduleParams {
  const raw = readJson5Object(filePath) as
    | { GhoTreasuryScheduleUpdate?: Record<string, unknown> }
    | Record<string, unknown>;

  const payload =
    typeof raw === "object" &&
    raw !== null &&
    "GhoTreasuryScheduleUpdate" in raw
      ? raw.GhoTreasuryScheduleUpdate
      : raw;

  if (typeof payload !== "object" || payload === null) {
    throw new Error("invalid parameters file shape");
  }

  const params = payload as Record<string, unknown>;
  const reimbursementConfigsRaw = Array.isArray(params.reimbursementConfigs)
    ? params.reimbursementConfigs
    : [];
  const seedFundingRaw = Array.isArray(params.seedFunding)
    ? params.seedFunding
    : [];

  return {
    vaultProxy: parseAddress(params.vaultProxy, "vaultProxy"),
    yieldRecipientTimelockController: parseAddress(
      params.yieldRecipientTimelockController,
      "yieldRecipientTimelockController",
    ),
    treasuryBootstrapOwner: parseOptionalAddress(
      params.treasuryBootstrapOwner,
      "treasuryBootstrapOwner",
    ),
    treasuryFinalOwner: parseOptionalAddress(
      params.treasuryFinalOwner,
      "treasuryFinalOwner",
    ),
    authorizeVault:
      params.authorizeVault === undefined
        ? true
        : parseBoolean(params.authorizeVault, "authorizeVault"),
    reimbursementConfigs: reimbursementConfigsRaw.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(
          `invalid reimbursementConfigs[${index}]: expected object`,
        );
      }
      const item = entry as Record<string, unknown>;
      return {
        strategy: parseAddress(
          item.strategy,
          `reimbursementConfigs[${index}].strategy`,
        ),
        token: parseAddress(item.token, `reimbursementConfigs[${index}].token`),
        enabled:
          item.enabled === undefined
            ? true
            : parseBoolean(
                item.enabled,
                `reimbursementConfigs[${index}].enabled`,
              ),
        remainingBudget: parseBigintLike(
          item.remainingBudget ?? 0n,
          `reimbursementConfigs[${index}].remainingBudget`,
        ),
      };
    }),
    seedFunding: seedFundingRaw.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`invalid seedFunding[${index}]: expected object`);
      }
      const item = entry as Record<string, unknown>;
      return {
        token: parseAddress(item.token, `seedFunding[${index}].token`),
        amount: parseBigintLike(item.amount, `seedFunding[${index}].amount`),
      };
    }),
    predecessor:
      params.predecessor === undefined
        ? zeroHash
        : parseBytes32(params.predecessor, "predecessor"),
    salt:
      params.salt === undefined ? zeroHash : parseBytes32(params.salt, "salt"),
    delay:
      params.delay === undefined
        ? 86400n
        : parseBigintLike(params.delay, "delay"),
  };
}

async function main() {
  const paramsPath = readParametersPath();
  const params = readParams(paramsPath);

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  if (deployer.account === undefined) {
    throw new Error("deployer wallet account is undefined");
  }

  const deployerAddress = getAddress(deployer.account.address);
  const bootstrapOwner = params.treasuryBootstrapOwner ?? deployerAddress;
  const needsBootstrapOwnerWrites =
    params.authorizeVault ||
    params.reimbursementConfigs.length !== 0 ||
    params.treasuryFinalOwner !== undefined;

  if (needsBootstrapOwnerWrites && bootstrapOwner !== deployerAddress) {
    throw new Error(
      "treasuryBootstrapOwner must be the deployer when the script is asked to configure the treasury or transfer ownership",
    );
  }

  const treasury = await viem.deployContract("YieldRecipientTreasury", [
    bootstrapOwner,
  ]);

  const authorizationHashes: Hex[] = [];
  if (params.authorizeVault) {
    const txHash = await treasury.write.setAuthorizedVault([
      params.vaultProxy,
      true,
    ]);
    authorizationHashes.push(txHash);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  const reimbursementConfigHashes: Hex[] = [];
  for (const config of params.reimbursementConfigs) {
    const txHash = await treasury.write.setReimbursementConfig([
      config.strategy,
      config.token,
      config.enabled,
      config.remainingBudget,
    ]);
    reimbursementConfigHashes.push(txHash);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  const fundingHashes: Hex[] = [];
  for (const funding of params.seedFunding) {
    const txHash = await deployer.writeContract({
      account: deployer.account,
      address: funding.token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [treasury.address, funding.amount],
    });
    fundingHashes.push(txHash);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  let ownershipTransferHash: Hex | undefined;
  if (
    params.treasuryFinalOwner !== undefined &&
    params.treasuryFinalOwner !== bootstrapOwner
  ) {
    ownershipTransferHash = await treasury.write.transferOwnership([
      params.treasuryFinalOwner,
    ]);
    await publicClient.waitForTransactionReceipt({
      hash: ownershipTransferHash,
    });
  }

  const setYieldRecipientCalldata = encodeFunctionData({
    abi: parseAbi(["function setYieldRecipient(address)"]),
    functionName: "setYieldRecipient",
    args: [treasury.address],
  });

  const operationId = (await publicClient.readContract({
    address: params.yieldRecipientTimelockController,
    abi: timelockAbi,
    functionName: "hashOperation",
    args: [
      params.vaultProxy,
      0n,
      setYieldRecipientCalldata,
      params.predecessor,
      params.salt,
    ],
  })) as Hex;

  const scheduleHash = await deployer.writeContract({
    account: deployer.account,
    address: params.yieldRecipientTimelockController,
    abi: timelockAbi,
    functionName: "schedule",
    args: [
      params.vaultProxy,
      0n,
      setYieldRecipientCalldata,
      params.predecessor,
      params.salt,
      params.delay,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: scheduleHash });

  const output = {
    network: await publicClient.getChainId(),
    treasury: treasury.address,
    treasuryBootstrapOwner: bootstrapOwner,
    treasuryPendingOwner:
      params.treasuryFinalOwner !== undefined &&
      params.treasuryFinalOwner !== bootstrapOwner
        ? params.treasuryFinalOwner
        : undefined,
    setAuthorizedVaultTxHashes: authorizationHashes,
    reimbursementConfigTxHashes: reimbursementConfigHashes,
    fundingTxHashes: fundingHashes,
    transferOwnershipTxHash: ownershipTransferHash,
    yieldRecipientTimelockController: params.yieldRecipientTimelockController,
    yieldRecipientUpdateCalldata: setYieldRecipientCalldata,
    yieldRecipientUpdateOperationId: operationId,
    scheduleYieldRecipientUpdateTxHash: scheduleHash,
  };

  console.log(`DEPLOY_JSON=${JSON.stringify(output)}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
