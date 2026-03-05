import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * YieldRecipientScheduleUpdateModule
 *
 * Purpose:
 * - Attach to existing vault + yield-recipient timelock.
 * - Schedule a timelocked yield-recipient update.
 *
 * Parameters (YieldRecipientScheduleUpdateModule.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - yieldRecipientTimelock: configured yield-recipient timelock address.
 * - newYieldRecipient: proposed new yield recipient.
 * - predecessor: predecessor operation id (bytes32), usually zero hash.
 * - salt: operation salt (bytes32).
 * - delay: execution delay in seconds for this operation.
 */
export default buildModule("YieldRecipientScheduleUpdateModule", (m) => {
  const vaultProxy = m.getParameter("vaultProxy");
  const yieldRecipientTimelockAddress = m.getParameter(
    "yieldRecipientTimelock",
  );
  const newYieldRecipient = m.getParameter("newYieldRecipient");
  const predecessor = m.getParameter(
    "predecessor",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  );
  const salt = m.getParameter(
    "salt",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  );
  const delay = m.getParameter("delay", 86400n);

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy);
  const timelock = m.contractAt(
    "TimelockController",
    yieldRecipientTimelockAddress,
  );
  const setYieldRecipientCalldata = m.encodeFunctionCall(
    vault,
    "setYieldRecipient",
    [newYieldRecipient],
  );

  m.call(timelock, "schedule", [
    vaultProxy,
    0n,
    setYieldRecipientCalldata,
    predecessor,
    salt,
    delay,
  ]);

  return { vault, timelock };
});
