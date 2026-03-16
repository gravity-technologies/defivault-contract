import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * MockAavePrerequisitesModule
 *
 * Purpose:
 * - Deploy MockAaveV3Pool for an existing underlying token.
 * - Deploy MockAaveV3AToken linked to that pool.
 * - Bind the pool back to the aToken via setAToken.
 *
 * Parameters (MockAavePrerequisitesModule.*):
 * - underlyingToken: existing ERC20 address used as the strategy underlying.
 * - aTokenName: ERC20 name for the mock aToken.
 * - aTokenSymbol: ERC20 symbol for the mock aToken.
 */
export default buildModule("MockAavePrerequisitesModule", (m) => {
  const underlyingToken = m.getParameter("underlyingToken");
  const aTokenName = m.getParameter("aTokenName");
  const aTokenSymbol = m.getParameter("aTokenSymbol");

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

  return { mockAaveAToken, mockAavePool, pool };
});
