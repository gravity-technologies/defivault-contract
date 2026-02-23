import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * TreasuryScheduleUpdateModule
 *
 * Purpose:
 * - Attach to existing vault + treasury timelock.
 * - Schedule a timelocked treasury recipient update.
 *
 * Parameters (TreasuryScheduleUpdateModule.*):
 * - vaultProxy: GRVTDeFiVault proxy address.
 * - treasuryTimelock: configured treasury timelock address.
 * - newTreasury: proposed new treasury recipient.
 * - predecessor: predecessor operation id (bytes32), usually zero hash.
 * - salt: operation salt (bytes32).
 * - delay: execution delay in seconds for this operation.
 */
export default buildModule("TreasuryScheduleUpdateModule", (m) => {
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
  const delay = m.getParameter("delay", 86400n);

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy);
  const timelock = m.contractAt(
    "TimelockController",
    treasuryTimelockAddress,
  );
  const setTreasuryCalldata = m.encodeFunctionCall(vault, "setTreasury", [
    newTreasury,
  ]);

  m.call(timelock, "schedule", [
    vaultProxy,
    0n,
    setTreasuryCalldata,
    predecessor,
    salt,
    delay,
  ]);

  return { vault, timelock };
});
