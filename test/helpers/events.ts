import assert from "node:assert/strict";

import { decodeEventLog } from "viem";

type LogEntry = {
  address: string;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
};

type ReceiptLike = {
  logs: readonly LogEntry[];
};

type ContractLike = {
  address: `0x${string}`;
  abi: unknown;
};

type EventArgs = Record<string, unknown>;

export function getEventArgs(
  receipt: ReceiptLike,
  contract: ContractLike,
  eventName: string,
): EventArgs[] {
  const events: EventArgs[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.address.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: contract.abi as Parameters<typeof decodeEventLog>[0]["abi"],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === eventName) {
        events.push(decoded.args as EventArgs);
      }
    } catch {
      continue;
    }
  }

  return events;
}

export function expectEventCount(
  receipt: ReceiptLike,
  contract: ContractLike,
  eventName: string,
  expectedCount: number,
) {
  const events = getEventArgs(receipt, contract, eventName);
  assert.equal(
    events.length,
    expectedCount,
    `expected ${eventName} count ${expectedCount}, got ${events.length}`,
  );
}

export function expectEventOnce(
  receipt: ReceiptLike,
  contract: ContractLike,
  eventName: string,
): EventArgs {
  const events = getEventArgs(receipt, contract, eventName);
  assert.equal(events.length, 1, `expected exactly one ${eventName} event, got ${events.length}`);
  return events[0];
}

export function expectEventArgs(actualArgs: EventArgs, expectedArgs: EventArgs) {
  for (const [key, expected] of Object.entries(expectedArgs)) {
    const actual = actualArgs[key];
    if (
      typeof actual === "string" &&
      typeof expected === "string" &&
      actual.startsWith("0x") &&
      expected.startsWith("0x") &&
      actual.length === 42 &&
      expected.length === 42
    ) {
      assert.equal(
        actual.toLowerCase(),
        expected.toLowerCase(),
        `unexpected value for event arg "${key}"`,
      );
      continue;
    }

    assert.equal(
      actual,
      expected,
      `unexpected value for event arg "${key}"`,
    );
  }
}
