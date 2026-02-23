import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * TreasuryExecuteUpdateModule
 *
 * Purpose:
 * - Attach to existing vault + treasury timelock.
 * - Execute a previously scheduled treasury recipient update.
 *
 * Parameters (TreasuryExecuteUpdateModule.*):
 * - vaultProxy: GRVTDeFiVault proxy address.
 * - treasuryTimelock: configured treasury timelock address.
 * - newTreasury: same treasury address used when scheduling the operation.
 * - predecessor: predecessor operation id (bytes32), usually zero hash.
 * - salt: operation salt (bytes32), must match scheduled operation.
 */
export default buildModule("TreasuryExecuteUpdateModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const treasuryTimelockAddress = m.getParameter("treasuryTimelock");
  const newTreasury = m.getParameter("newTreasury");
  const predecessor = m.getParameter(
    "predecessor",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  );
  const salt = m.getParameter(
    "salt",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  );

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);
  const timelock = m.contractAt(
    "TimelockController",
    treasuryTimelockAddress,
  );
  const setTreasuryCalldata = m.encodeFunctionCall(vault, "setTreasury", [
    newTreasury,
  ]);

  m.call(timelock, "execute", [
    vaultProxy,
    0n,
    setTreasuryCalldata,
    predecessor,
    salt,
  ]);

  return { vault, timelock };
});
