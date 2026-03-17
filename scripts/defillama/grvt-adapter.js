/**
 * DefiLlama SDK adapter template for GRVT L1 Treasury Vault.
 *
 * See: https://docs.llama.fi/list-your-project/how-to-write-an-sdk-adapter
 *
 * Copy this into `projects/<project-name>/index.js` in the DefiLlama adapters
 * repo and replace the placeholder values below with live deployment data.
 */

const CHAIN = "ethereum";
const VAULT_ADDRESS = "0x0000000000000000000000000000000000000000";
const START_BLOCK = 0;

const ABI = {
  getTrackedTvlTokens:
    "function getTrackedTvlTokens() view returns (address[])",
  tokenTotals:
    "function tokenTotals(address queryToken) view returns (uint256 idle, uint256 strategy, uint256 total)",
};

async function tvl(api) {
  const trackedTokens = await api.call({
    abi: ABI.getTrackedTvlTokens,
    target: VAULT_ADDRESS,
  });

  if (trackedTokens.length === 0) return;

  const totals = await api.multiCall({
    abi: ABI.tokenTotals,
    calls: trackedTokens.map((queryToken) => ({
      params: [queryToken],
      target: VAULT_ADDRESS,
    })),
  });

  api.addTokens(
    trackedTokens,
    totals.map(({ total }) => total),
  );
}

module.exports = {
  methodology:
    "Counts each tracked TVL token reported by the GRVT L1 Treasury Vault. The adapter reads the vault's tracked token registry, then queries strict per-token totals so direct vault balances and strategy-held balances are both included without relying on off-chain accounting.",
  misrepresentedTokens: false,
  start: START_BLOCK,
  [CHAIN]: {
    tvl,
  },
};
