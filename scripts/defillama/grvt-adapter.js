/**
 * DefiLlama SDK adapter template for GRVT L1 Treasury Vault.
 *
 * See: https://docs.llama.fi/list-your-project/how-to-write-an-sdk-adapter
 *
 * Copy this into `projects/<project-name>/index.js` in the DefiLlama adapters
 * repo and replace the placeholder values below with live deployment data.
 *
 * Setup:
 * - TVL is the sum of two custody locations on Ethereum mainnet:
 *   1. assets reported by the GRVT L1 Treasury Vault via `getTrackedTvlTokens()`
 *      and `tokenTotals()`
 *   2. assets currently held in the zkSync bridge stack
 * - The bridge leg is intentionally limited to USDT, USDC, and native ETH.
 * - The vault leg is optional: if the configured vault address is unset, has no
 *   bytecode, or the reads revert, the adapter falls back to reporting only the
 *   zkSync bridge balances.
 */

const CHAIN = "ethereum";
const VAULT_ADDRESS = "0x0000000000000000000000000000000000000000";
const START_BLOCK = 0;
const ZKSYNC_BRIDGE_HUB = "0x303a465B659cBB0ab36eE643eA362c509EEb5213";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZKSYNC_BRIDGE_TOKENS = [
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
];

const ABI = {
  getTrackedTvlTokens:
    "function getTrackedTvlTokens() view returns (address[])",
  tokenTotals:
    "function tokenTotals(address queryToken) view returns (uint256 idle, uint256 strategy, uint256 total)",
  sharedBridge: "function sharedBridge() view returns (address)",
  nativeTokenVault: "function nativeTokenVault() view returns (address)",
  balanceOf: "erc20:balanceOf",
};

function isNonZero(balance) {
  return balance !== undefined && balance !== null && BigInt(balance) !== 0n;
}

async function vaultExists(api) {
  if (VAULT_ADDRESS.toLowerCase() === ZERO_ADDRESS) return false;

  const code = await api.provider.getCode(VAULT_ADDRESS);
  return typeof code === "string" && code !== "0x";
}

async function addVaultBalances(api) {
  // Step 1: if the vault address is unset or has no bytecode, skip this leg.
  if (!(await vaultExists(api))) return;

  // Step 2: read the vault's tracked token registry. A revert here should not
  // break the bridge leg, so the adapter falls back gracefully.
  let trackedTokens;
  try {
    trackedTokens = await api.call({
      abi: ABI.getTrackedTvlTokens,
      target: VAULT_ADDRESS,
    });
  } catch {
    return;
  }

  if (trackedTokens.length === 0) return;

  // Step 3: fetch strict per-token totals for every tracked token in one batch.
  let totals;
  try {
    totals = await api.multiCall({
      abi: ABI.tokenTotals,
      calls: trackedTokens.map((queryToken) => ({
        params: [queryToken],
        target: VAULT_ADDRESS,
      })),
    });
  } catch {
    return;
  }

  // Step 4: keep only non-zero totals so the adapter reports compact balances.
  const nonZeroTokens = [];
  const nonZeroTotals = [];

  trackedTokens.forEach((token, index) => {
    const total = totals[index]?.total;
    if (!isNonZero(total)) return;
    nonZeroTokens.push(token);
    nonZeroTotals.push(total);
  });

  if (nonZeroTokens.length > 0) api.addTokens(nonZeroTokens, nonZeroTotals);
}

async function addZkSyncBridgeBalances(api) {
  // Step 1: resolve the zkSync shared bridge address used by the bridge hub.
  const sharedBridge = await api.call({
    abi: ABI.sharedBridge,
    target: ZKSYNC_BRIDGE_HUB,
  });

  // Step 2: read the bridge-held ERC20 balances for the supported bridge tokens.
  const tokenBalances = await api.multiCall({
    abi: ABI.balanceOf,
    calls: ZKSYNC_BRIDGE_TOKENS.map((token) => ({
      target: token,
      params: [sharedBridge],
    })),
  });

  ZKSYNC_BRIDGE_TOKENS.forEach((token, index) => {
    const balance = tokenBalances[index];
    if (isNonZero(balance)) api.add(token, balance);
  });

  // Step 3: resolve the native-token vault and report any ETH it currently holds.
  const nativeTokenVault = await api.call({
    abi: ABI.nativeTokenVault,
    target: sharedBridge,
  });
  const nativeBalance = await api.provider.getBalance(nativeTokenVault);

  if (isNonZero(nativeBalance)) api.addGasToken(nativeBalance);
}

async function tvl(api) {
  // The vault leg and bridge leg are independent, so run them in parallel.
  await Promise.all([addVaultBalances(api), addZkSyncBridgeBalances(api)]);
  return api.getBalances();
}

module.exports = {
  methodology:
    "Counts GRVT TVL as the sum of tracked balances reported by the GRVT L1 Treasury Vault plus assets currently custodied in the zkSync bridge. The vault leg reads the tracked token registry and strict per-token totals, while the bridge leg adds non-zero USDT, USDC, and native ETH balances from the zkSync shared bridge/native token vault.",
  misrepresentedTokens: false,
  start: START_BLOCK,
  [CHAIN]: {
    tvl,
  },
};
