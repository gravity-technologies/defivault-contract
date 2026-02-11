import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * VaultCoreModule
 *
 * Purpose:
 * - Deploy GRVTDeFiVault implementation.
 * - Deploy OpenZeppelin TransparentUpgradeableProxy.
 * - Initialize the vault proxy in constructor calldata.
 *
 * Parameters (VaultCoreModule.*):
 * - deployAdmin: admin for vault initialize + proxy admin.
 * - bridgeHub: L1 zkSync BridgeHub address.
 * - baseToken: GRVT base token (mintable) address.
 * - l2ChainId: target L2 chain id.
 * - l2ExchangeRecipient: fixed L2 recipient for top-ups.
 * - wrappedNativeToken: canonical wrapped-native token address (for native intent canonicalization).
 */
export default buildModule("VaultCoreModule", (m) => {
  const deployAdmin = m.getParameter("deployAdmin");
  const bridgeHub = m.getParameter("bridgeHub");
  const baseToken = m.getParameter("baseToken");
  const l2ChainId = m.getParameter("l2ChainId");
  const l2ExchangeRecipient = m.getParameter("l2ExchangeRecipient");
  const wrappedNativeToken = m.getParameter("wrappedNativeToken");

  const vaultImplementation = m.contract("GRVTDeFiVault", [], {
    id: "VaultImplementation",
  });

  const initializeCalldata = m.encodeFunctionCall(
    vaultImplementation,
    "initialize",
    [
      deployAdmin,
      bridgeHub,
      baseToken,
      l2ChainId,
      l2ExchangeRecipient,
      wrappedNativeToken,
    ],
    { id: "VaultInitializeCalldata" },
  );

  const vaultProxy = m.contract("TransparentUpgradeableProxy", [
    vaultImplementation,
    deployAdmin,
    initializeCalldata,
  ], { id: "VaultProxy" });

  const vault = m.contractAt("GRVTDeFiVault", vaultProxy, { id: "Vault" });

  return { vaultImplementation, vaultProxy, vault };
});
