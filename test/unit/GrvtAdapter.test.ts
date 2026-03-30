import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADAPTER_PATH = resolve(REPO_ROOT, "scripts/defillama/grvt-adapter.js");
const UNSET_VAULT_ADDRESS = "0x0000000000000000000000000000000000000000";
const PATCHED_VAULT_ADDRESS = "0x1111111111111111111111111111111111111111";
const ZKSYNC_BRIDGE_HUB = "0x303a465B659cBB0ab36eE643eA362c509EEb5213";
const SHARED_BRIDGE = "0x2222222222222222222222222222222222222222";
const NATIVE_TOKEN_VAULT = "0x3333333333333333333333333333333333333333";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const V2_TOKEN = "0x4444444444444444444444444444444444444444";
const V3_TOKEN = "0x5555555555555555555555555555555555555555";

type MockApi = {
  addCalls: Array<[string, bigint]>;
  addGasTokenCalls: bigint[];
  addTokensCalls: Array<{ balances: bigint[]; tokens: string[] }>;
  callHistory: Array<{ abi: string; target: string }>;
  getBalancesCalls: number;
  multiCallHistory: Array<{
    abi: string;
    params: unknown[][];
    targets: string[];
  }>;
  provider: {
    getBalance: (address: string) => Promise<bigint>;
    getCode: (address: string) => Promise<string>;
  };
};

type AdapterApi = MockApi & {
  add(token: string, balance: bigint): void;
  addGasToken(balance: bigint): void;
  addTokens(tokens: string[], balances: bigint[]): void;
  call({ abi, target }: { abi: string; target: string }): Promise<unknown>;
  getBalances(): {
    addCalls: [string, bigint][];
    addGasTokenCalls: bigint[];
    addTokensCalls: Array<{ balances: bigint[]; tokens: string[] }>;
  };
  multiCall({
    abi,
    calls,
  }: {
    abi: string;
    calls: Array<{ params?: unknown[]; target: string }>;
  }): Promise<unknown[]>;
  __mock: MockApi;
};

function loadAdapter(vaultAddress = UNSET_VAULT_ADDRESS) {
  const source = readFileSync(ADAPTER_PATH, "utf8").replace(
    'const VAULT_ADDRESS = "0x0000000000000000000000000000000000000000";',
    `const VAULT_ADDRESS = "${vaultAddress}";`,
  );
  const sandbox = {
    BigInt,
    Promise,
    clearTimeout,
    console,
    module: { exports: {} },
    setTimeout,
  } as const;

  runInNewContext(source, sandbox, {
    filename: ADAPTER_PATH,
    timeout: 1000,
  });

  return sandbox.module.exports as {
    ethereum: {
      tvl: (api: AdapterApi) => Promise<unknown>;
    };
    methodology: string;
    misrepresentedTokens: boolean;
    start: number;
  };
}

function createApi(
  config: {
    bridgeTokenBalances?: Partial<Record<string, bigint>>;
    failTrackedTokensRead?: boolean;
    failTokenTotalsRead?: boolean;
    getBalance?: bigint;
    getCode?: string;
    trackedTokens?: string[];
    vaultTokenTotals?: Partial<Record<string, bigint>>;
  } = {},
): AdapterApi {
  const mock: MockApi = {
    addCalls: [],
    addGasTokenCalls: [],
    addTokensCalls: [],
    callHistory: [],
    getBalancesCalls: 0,
    multiCallHistory: [],
    provider: {
      getBalance: async () => config.getBalance ?? 0n,
      getCode: async () => config.getCode ?? "0x",
    },
  };

  return {
    add(token: string, balance: bigint) {
      mock.addCalls.push([token, balance]);
    },
    addGasToken(balance: bigint) {
      mock.addGasTokenCalls.push(balance);
    },
    addTokens(tokens: string[], balances: bigint[]) {
      mock.addTokensCalls.push({
        balances: [...balances],
        tokens: [...tokens],
      });
    },
    getBalances() {
      mock.getBalancesCalls += 1;
      return {
        addCalls: mock.addCalls,
        addGasTokenCalls: mock.addGasTokenCalls,
        addTokensCalls: mock.addTokensCalls,
      };
    },
    async call({ abi, target }: { abi: string; target: string }) {
      mock.callHistory.push({ abi, target });
      if (abi.includes("sharedBridge")) return SHARED_BRIDGE;
      if (abi.includes("getTrackedTvlTokens")) {
        if (config.failTrackedTokensRead) {
          throw new Error("vault read failed");
        }
        return config.trackedTokens ?? [];
      }
      if (abi.includes("nativeTokenVault")) return NATIVE_TOKEN_VAULT;
      throw new Error(`unexpected call: ${abi} -> ${target}`);
    },
    async multiCall({
      abi,
      calls,
    }: {
      abi: string;
      calls: Array<{ params?: unknown[]; target: string }>;
    }) {
      mock.multiCallHistory.push({
        abi,
        params: calls.map((call) => call.params ?? []),
        targets: calls.map((call) => call.target),
      });
      if (abi.includes("balanceOf")) {
        return calls.map(
          ({ target }) => config.bridgeTokenBalances?.[target] ?? 0n,
        );
      }
      if (abi.includes("tokenTotals")) {
        if (config.failTokenTotalsRead) {
          throw new Error("vault totals read failed");
        }
        return calls.map(({ params }) => {
          const token = params?.[0];
          if (typeof token !== "string") {
            throw new Error("tokenTotals call missing token param");
          }
          return { total: config.vaultTokenTotals?.[token] ?? 0n };
        });
      }
      throw new Error(`unexpected multicall: ${abi}`);
    },
    __mock: mock,
    provider: mock.provider,
  } as AdapterApi;
}

function callHistoryKeys(history: Array<{ abi: string; target: string }>) {
  return history.map(({ abi, target }) => `${abi} -> ${target}`).sort();
}

function multiCallHistoryKeys(
  history: Array<{ abi: string; params: unknown[][]; targets: string[] }>,
) {
  return history
    .map(
      ({ abi, params, targets }) =>
        `${abi} -> params:${JSON.stringify(params)} targets:${targets.join(",")}`,
    )
    .sort();
}

describe("scripts/defillama/grvt-adapter.js", function () {
  it("keeps the DefiLlama CommonJS export shape", function () {
    const adapter = loadAdapter();

    assert.equal(typeof adapter.methodology, "string");
    assert.equal(adapter.misrepresentedTokens, false);
    assert.equal(adapter.start, 0);
    assert.equal(typeof adapter.ethereum.tvl, "function");
  });

  it("reports bridge balances only when the vault address is unset", async function () {
    const adapter = loadAdapter();
    const api = createApi({
      bridgeTokenBalances: {
        [USDT]: 17n,
        [USDC]: 0n,
      },
      getBalance: 9n,
    });

    const result = await adapter.ethereum.tvl(api);

    assert.deepEqual(callHistoryKeys(api.__mock.callHistory), [
      "function nativeTokenVault() view returns (address) -> 0x2222222222222222222222222222222222222222",
      `function sharedBridge() view returns (address) -> ${ZKSYNC_BRIDGE_HUB}`,
    ]);
    assert.deepEqual(multiCallHistoryKeys(api.__mock.multiCallHistory), [
      `erc20:balanceOf -> params:[["${SHARED_BRIDGE}"],["${SHARED_BRIDGE}"]] targets:${USDT},${USDC}`,
    ]);
    assert.deepEqual(api.__mock.addCalls, [[USDT, 17n]]);
    assert.deepEqual(api.__mock.addGasTokenCalls, [9n]);
    assert.deepEqual(api.__mock.addTokensCalls, []);
    assert.equal(api.__mock.getBalancesCalls, 1);
    assert.deepEqual(result, {
      addCalls: [[USDT, 17n]],
      addGasTokenCalls: [9n],
      addTokensCalls: [],
    });
  });

  it("includes vault totals when the vault reads succeed", async function () {
    const adapter = loadAdapter(PATCHED_VAULT_ADDRESS);
    const api = createApi({
      bridgeTokenBalances: {
        [USDT]: 17n,
        [USDC]: 0n,
      },
      getBalance: 11n,
      getCode: "0x60016000",
      trackedTokens: [V2_TOKEN, V3_TOKEN],
      vaultTokenTotals: {
        [V2_TOKEN]: 0n,
        [V3_TOKEN]: 42n,
      },
    });

    const result = await adapter.ethereum.tvl(api);

    assert.equal(api.__mock.getBalancesCalls, 1);
    assert.deepEqual(callHistoryKeys(api.__mock.callHistory), [
      "function getTrackedTvlTokens() view returns (address[]) -> 0x1111111111111111111111111111111111111111",
      "function nativeTokenVault() view returns (address) -> 0x2222222222222222222222222222222222222222",
      `function sharedBridge() view returns (address) -> ${ZKSYNC_BRIDGE_HUB}`,
    ]);
    assert.deepEqual(multiCallHistoryKeys(api.__mock.multiCallHistory), [
      `erc20:balanceOf -> params:[["${SHARED_BRIDGE}"],["${SHARED_BRIDGE}"]] targets:${USDT},${USDC}`,
      `function tokenTotals(address queryToken) view returns (uint256 idle, uint256 strategy, uint256 total) -> params:[["${V2_TOKEN}"],["${V3_TOKEN}"]] targets:${PATCHED_VAULT_ADDRESS},${PATCHED_VAULT_ADDRESS}`,
    ]);
    assert.deepEqual(api.__mock.addCalls, [[USDT, 17n]]);
    assert.deepEqual(api.__mock.addGasTokenCalls, [11n]);
    assert.deepEqual(api.__mock.addTokensCalls, [
      {
        tokens: [V3_TOKEN],
        balances: [42n],
      },
    ]);
    assert.deepEqual(result, {
      addCalls: [[USDT, 17n]],
      addGasTokenCalls: [11n],
      addTokensCalls: [{ tokens: [V3_TOKEN], balances: [42n] }],
    });
  });

  it("ignores an empty tracked token registry but still reports bridge balances", async function () {
    const adapter = loadAdapter(PATCHED_VAULT_ADDRESS);
    const api = createApi({
      bridgeTokenBalances: {
        [USDT]: 5n,
        [USDC]: 0n,
      },
      getBalance: 7n,
      getCode: "0x60016000",
      trackedTokens: [],
    });

    await adapter.ethereum.tvl(api);

    assert.deepEqual(callHistoryKeys(api.__mock.callHistory), [
      "function getTrackedTvlTokens() view returns (address[]) -> 0x1111111111111111111111111111111111111111",
      "function nativeTokenVault() view returns (address) -> 0x2222222222222222222222222222222222222222",
      `function sharedBridge() view returns (address) -> ${ZKSYNC_BRIDGE_HUB}`,
    ]);
    assert.deepEqual(multiCallHistoryKeys(api.__mock.multiCallHistory), [
      `erc20:balanceOf -> params:[["${SHARED_BRIDGE}"],["${SHARED_BRIDGE}"]] targets:${USDT},${USDC}`,
    ]);
    assert.deepEqual(api.__mock.addCalls, [[USDT, 5n]]);
    assert.deepEqual(api.__mock.addTokensCalls, []);
    assert.deepEqual(api.__mock.addGasTokenCalls, [7n]);
  });

  it("skips vault token aggregation when tokenTotals reads fail", async function () {
    const adapter = loadAdapter(PATCHED_VAULT_ADDRESS);
    const api = createApi({
      bridgeTokenBalances: {
        [USDT]: 3n,
        [USDC]: 0n,
      },
      failTokenTotalsRead: true,
      getBalance: 0n,
      getCode: "0x60016000",
      trackedTokens: [V2_TOKEN, V3_TOKEN],
      vaultTokenTotals: {
        [V2_TOKEN]: 0n,
        [V3_TOKEN]: 42n,
      },
    });

    await adapter.ethereum.tvl(api);

    assert.deepEqual(callHistoryKeys(api.__mock.callHistory), [
      "function getTrackedTvlTokens() view returns (address[]) -> 0x1111111111111111111111111111111111111111",
      "function nativeTokenVault() view returns (address) -> 0x2222222222222222222222222222222222222222",
      `function sharedBridge() view returns (address) -> ${ZKSYNC_BRIDGE_HUB}`,
    ]);
    assert.deepEqual(api.__mock.addCalls, [[USDT, 3n]]);
    assert.deepEqual(api.__mock.addTokensCalls, []);
    assert.deepEqual(api.__mock.addGasTokenCalls, []);
  });

  it("filters zero bridge and vault balances out of the final report", async function () {
    const adapter = loadAdapter(PATCHED_VAULT_ADDRESS);
    const api = createApi({
      bridgeTokenBalances: {
        [USDT]: 0n,
        [USDC]: 0n,
      },
      getBalance: 0n,
      getCode: "0x60016000",
      trackedTokens: [V2_TOKEN, V3_TOKEN],
      vaultTokenTotals: {
        [V2_TOKEN]: 0n,
        [V3_TOKEN]: 0n,
      },
    });

    await adapter.ethereum.tvl(api);

    assert.deepEqual(api.__mock.addCalls, []);
    assert.deepEqual(api.__mock.addGasTokenCalls, []);
    assert.deepEqual(api.__mock.addTokensCalls, []);
  });

  it("falls back to bridge balances when the vault token read reverts", async function () {
    const adapter = loadAdapter(PATCHED_VAULT_ADDRESS);
    const api = createApi({
      bridgeTokenBalances: {
        [USDT]: 17n,
        [USDC]: 0n,
      },
      failTrackedTokensRead: true,
      getBalance: 13n,
      getCode: "0x60016000",
    });

    await adapter.ethereum.tvl(api);

    assert.deepEqual(api.__mock.addTokensCalls, []);
    assert.deepEqual(api.__mock.addCalls, [[USDT, 17n]]);
    assert.deepEqual(api.__mock.addGasTokenCalls, [13n]);
  });
});
