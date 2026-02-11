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
 * - underlyingToken: ERC20 token managed by this strategy (e.g. USDT).
 * - tokenSupported: value for setTokenConfig(token, { supported }).
 * - strategyWhitelisted: value for whitelistStrategy(..., { whitelisted }).
 * - strategyActive: value for whitelistStrategy(..., { active }).
 * - strategyCap: cap for whitelistStrategy(token, strategy, { cap }).
 */
export default buildModule("TokenStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const strategyProxy = m.getParameter("strategyProxy");
  const underlyingToken = m.getParameter("underlyingToken");
  const tokenSupported = m.getParameter("tokenSupported", true);
  const strategyWhitelisted = m.getParameter("strategyWhitelisted", true);
  const strategyActive = m.getParameter("strategyActive", false);
  const strategyCap = m.getParameter("strategyCap", 0n);

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy, { id: "Vault" });
  m.call(
    vault,
    "setTokenConfig",
    [underlyingToken, { supported: tokenSupported }],
    { id: "SetUnderlyingTokenConfig" },
  );
  m.call(
    vault,
    "whitelistStrategy",
    [
      underlyingToken,
      strategyProxy,
      {
        whitelisted: strategyWhitelisted,
        active: strategyActive,
        cap: strategyCap,
      },
    ],
    { id: "WhitelistAaveStrategy" },
  );

  const strategy = m.contractAt("IYieldStrategy", strategyProxy, {
    id: "Strategy",
  });

  return { strategy, vault };
});
