import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * TokenStrategyModule
 *
 * Purpose:
 * - Apply token support + strategy whitelist on an existing vault.
 * - Keep strategy onboarding deterministic in Ignition state.
 *
 * Parameters (TokenStrategyModule.*):
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 * - strategyProxy: existing strategy proxy address.
 * - underlyingToken: canonical principal token key (ERC20) for this strategy binding.
 * - tokenSupported: value for setTokenConfig(token, { supported }).
 * - strategyWhitelisted: value for whitelistStrategy(..., { whitelisted }).
 * - strategyCap: cap for whitelistStrategy(token, strategy, { cap }).
 *
 * Notes:
 * - `StrategyConfig.active` is lifecycle output-state derived by vault internals.
 *   This module always passes `active: false` on input and lets vault derive final state.
 */
export default buildModule("TokenStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const strategyProxy = m.getParameter("strategyProxy");
  const underlyingToken = m.getParameter("underlyingToken");
  const tokenSupported = m.getParameter("tokenSupported", true);
  const strategyWhitelisted = m.getParameter("strategyWhitelisted", true);
  const strategyCap = m.getParameter("strategyCap", 0n);

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy, { id: "Vault" });
  m.call(vault, "setTokenConfig", [
    underlyingToken,
    { supported: tokenSupported },
  ], { id: "SetUnderlyingTokenConfig" });
  m.call(vault, "whitelistStrategy", [
    underlyingToken,
    strategyProxy,
    {
      whitelisted: strategyWhitelisted,
      active: false,
      cap: strategyCap,
    },
  ], { id: "WhitelistAaveStrategy" });

  const strategy = m.contractAt("IYieldStrategy", strategyProxy, {
    id: "Strategy",
  });

  return { strategy, vault };
});
