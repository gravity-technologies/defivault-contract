import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * PrincipalTokenStrategyModule
 *
 * Purpose:
 * - Apply principal-token support + strategy whitelist on an existing vault.
 * - Keep strategy onboarding deterministic in Ignition state.
 *
 * Parameters (PrincipalTokenStrategyModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - strategyProxy: existing strategy proxy address.
 * - principalToken: canonical principal token key (ERC20) for this strategy binding.
 * - principalTokenSupported: value for setPrincipalTokenConfig(token, { supported }).
 * - principalStrategyWhitelisted: value for setPrincipalStrategyWhitelist(..., { whitelisted }).
 * - strategyCap: cap for setPrincipalStrategyWhitelist(token, strategy, { cap }).
 *
 * Notes:
 * - `PrincipalStrategyConfig.active` is lifecycle output-state derived by vault internals.
 *   This module always passes `active: false` on input and lets vault derive final state.
 */
export default buildModule("PrincipalTokenStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const strategyProxy = m.getParameter("strategyProxy");
  const principalToken = m.getParameter("principalToken");
  const principalTokenSupported = m.getParameter(
    "principalTokenSupported",
    true,
  );
  const principalStrategyWhitelisted = m.getParameter(
    "principalStrategyWhitelisted",
    true,
  );
  const strategyCap = m.getParameter("strategyCap", 0n);

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });
  const setPrincipalTokenConfig = m.call(
    vault,
    "setPrincipalTokenConfig",
    [principalToken, { supported: principalTokenSupported }],
    { id: "SetPrincipalTokenConfig" },
  );
  m.call(
    vault,
    "setPrincipalStrategyWhitelist",
    [
      principalToken,
      strategyProxy,
      {
        whitelisted: principalStrategyWhitelisted,
        active: false,
        cap: strategyCap,
      },
    ],
    {
      id: "SetPrincipalStrategyWhitelist",
      after: [setPrincipalTokenConfig],
    },
  );

  const strategy = m.contractAt("IYieldStrategy", strategyProxy, {
    id: "Strategy",
  });

  return { strategy, vault };
});
