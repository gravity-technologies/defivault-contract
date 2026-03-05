import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * YieldRecipientExecuteUpdateModule
 *
 * Purpose:
 * - Attach to existing vault + yield-recipient timelock.
 * - Execute a previously scheduled yield-recipient update.
 *
 * Parameters (YieldRecipientExecuteUpdateModule.*):
 * - vaultProxy: GRVTL1TreasuryVault proxy address.
 * - yieldRecipientTimelock: configured yield-recipient timelock address.
 * - newYieldRecipient: same yield-recipient address used when scheduling the operation.
 * - predecessor: predecessor operation id (bytes32), usually zero hash.
 * - salt: operation salt (bytes32), must match scheduled operation.
 */
export default buildModule("YieldRecipientExecuteUpdateModule", (m) => {
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

  m.call(timelock, "execute", [
    vaultProxy,
    0n,
    setYieldRecipientCalldata,
    predecessor,
    salt,
  ]);

  return { vault, timelock };
});
