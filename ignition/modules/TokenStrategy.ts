import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * TokenStrategyModule
 *
 * Purpose:
 * - Attach to an existing vault.
 * - Deploy AaveV3Strategy implementation + proxy.
 * - Configure token support on vault.
 * - Whitelist the deployed strategy for the token.
 *
 * Parameters (TokenStrategyModule.*):
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 * - proxyAdmin: admin for strategy proxy.
 * - aavePool: Aave V3 pool address.
 * - underlyingToken: ERC20 token managed by this strategy (e.g. USDT).
 * - aToken: corresponding aToken address (e.g. aUSDT).
 * - strategyName: strategy identifier string.
 * - tokenSupported: value for setTokenConfig(token, { supported }).
 * - strategyCap: cap for whitelistStrategy(token, strategy, { cap }).
 */
export default buildModule("TokenStrategyModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const proxyAdmin = m.getParameter("proxyAdmin");
  const aavePool = m.getParameter("aavePool");
  const underlyingToken = m.getParameter("underlyingToken");
  const aToken = m.getParameter("aToken");
  const strategyName = m.getParameter("strategyName", "AAVE_V3_UNDERLYING");
  const tokenSupported = m.getParameter("tokenSupported", true);
  const strategyCap = m.getParameter("strategyCap", 0n);

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);
  const strategyImplementation = m.contract("AaveV3Strategy");

  const initializeCalldata = m.encodeFunctionCall(
    strategyImplementation,
    "initialize",
    [vaultProxy, aavePool, underlyingToken, aToken, strategyName],
  );

  const strategyProxy = m.contract("TestTransparentUpgradeableProxy", [
    strategyImplementation,
    proxyAdmin,
    initializeCalldata,
  ]);

  // Keep vault config deterministic and fully tracked in Ignition state.
  m.call(vault, "setTokenConfig", [
    underlyingToken,
    { supported: tokenSupported },
  ]);
  m.call(vault, "whitelistStrategy", [
    underlyingToken,
    strategyProxy,
    { whitelisted: true, active: false, cap: strategyCap },
  ]);

  const strategy = m.contractAt("AaveV3Strategy", strategyProxy);

  return { strategyImplementation, strategyProxy, strategy };
});
