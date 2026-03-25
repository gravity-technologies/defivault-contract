import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultTokenStrategyModule
 *
 * Purpose:
 * - Apply vault-token support + strategy whitelist on an existing vault.
 * - Keep strategy onboarding deterministic in Ignition state.
 *
 * Parameters (VaultTokenStrategyModule.*):
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - strategyProxy: existing strategy proxy address.
 * - vaultToken: canonical vault token key (ERC20) for this strategy binding.
 * - vaultTokenSupported: value for setVaultTokenConfig(token, { supported }).
 * - vaultTokenStrategyWhitelisted: value for setVaultTokenStrategyConfig(..., { whitelisted }).
 * - strategyCap: cap for setVaultTokenStrategyConfig(token, strategy, { cap }).
 *
 * Notes:
 * - `VaultTokenStrategyConfig.active` is lifecycle output-state derived by vault internals.
 *   This module always passes `active: false` on input and lets vault derive final state.
 */
export default buildModule("VaultTokenStrategyModule", (m: any) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const strategyProxy = m.getParameter("strategyProxy");
  const vaultToken = m.getParameter("vaultToken");
  const vaultTokenSupported = m.getParameter("vaultTokenSupported", true);
  const vaultTokenStrategyWhitelisted = m.getParameter(
    "vaultTokenStrategyWhitelisted",
    true,
  );
  const strategyCap = m.getParameter("strategyCap", 0n);

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });
  const setVaultTokenConfig = m.call(
    vault,
    "setVaultTokenConfig",
    [vaultToken, { supported: vaultTokenSupported }],
    { id: "SetVaultTokenConfig" },
  );
  m.call(
    vault,
    "setVaultTokenStrategyConfig",
    [
      vaultToken,
      strategyProxy,
      {
        whitelisted: vaultTokenStrategyWhitelisted,
        active: false,
        cap: strategyCap,
      },
    ],
    {
      id: "SetVaultTokenStrategyConfig",
      after: [setVaultTokenConfig],
    },
  );

  const strategy = m.contractAt("IYieldStrategy", strategyProxy, {
    id: "Strategy",
  });

  return { strategy, vault };
});
