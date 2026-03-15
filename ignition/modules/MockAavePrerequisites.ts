import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * MockAavePrerequisitesModule
 *
 * Purpose:
 * - Deploy a mock underlying ERC20 token for non-production strategy testing.
 * - Deploy MockAaveV3Pool for a chosen underlying token.
 * - Deploy MockAaveV3AToken linked to that pool.
 * - Bind the pool back to the aToken via setAToken.
 *
 * Parameters (MockAavePrerequisitesModule.*):
 * - underlyingTokenName: ERC20 name for the mock underlying token.
 * - underlyingTokenSymbol: ERC20 symbol for the mock underlying token.
 * - underlyingTokenDecimals: ERC20 decimals for the mock underlying token.
 * - aTokenName: ERC20 name for the mock aToken.
 * - aTokenSymbol: ERC20 symbol for the mock aToken.
 */
export default buildModule("MockAavePrerequisitesModule", (m) => {
  const underlyingTokenName = m.getParameter("underlyingTokenName");
  const underlyingTokenSymbol = m.getParameter("underlyingTokenSymbol");
  const underlyingTokenDecimals = m.getParameter("underlyingTokenDecimals");
  const aTokenName = m.getParameter("aTokenName");
  const aTokenSymbol = m.getParameter("aTokenSymbol");

  const underlyingToken = m.contract(
    "MockERC20",
    [underlyingTokenName, underlyingTokenSymbol, underlyingTokenDecimals],
    {
      id: "MockUnderlyingToken",
    },
  );

  const mockAavePool = m.contract("MockAaveV3Pool", [underlyingToken], {
    id: "MockAavePool",
  });
  const mockAaveAToken = m.contract(
    "MockAaveV3AToken",
    [underlyingToken, mockAavePool, aTokenName, aTokenSymbol],
    { id: "MockAaveAToken" },
  );

  const pool = m.contractAt("MockAaveV3Pool", mockAavePool, {
    id: "MockAavePoolContract",
  });

  m.call(pool, "setAToken", [mockAaveAToken], {
    id: "BindMockAaveAToken",
    after: [mockAaveAToken],
  });

  return { mockAaveAToken, mockAavePool, pool, underlyingToken };
});
