import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { transparentUpgradeableProxyArtifact } from "./shared/transparentProxyArtifact.js";

/**
 * VaultCoreModule
 *
 * Purpose:
 * - Deploy GRVTL1TreasuryVault implementation.
 * - Deploy OpenZeppelin TransparentUpgradeableProxy.
 * - Initialize the vault proxy in constructor calldata.
 *
 * Parameters (VaultCoreModule.*):
 * - deployAdmin: admin for vault initialize + proxy admin.
 * - bridgeHub: L1 zkSync BridgeHub address.
 * - grvtBridgeProxyFeeToken: GRVT bridge-proxy fee token address used for `mintValue`.
 * - l2ChainId: target L2 chain id.
 * - l2ExchangeRecipient: fixed L2 recipient for top-ups.
 * - wrappedNativeToken: canonical wrapped-native token address (for native intent canonicalization).
 * - yieldRecipient: initial yield recipient for harvest payouts and native sweeps.
 */
export default buildModule("VaultCoreModule", (m) => {
  const deployAdmin = m.getParameter("deployAdmin");
  const bridgeHub = m.getParameter("bridgeHub");
  const grvtBridgeProxyFeeToken = m.getParameter("grvtBridgeProxyFeeToken");
  const l2ChainId = m.getParameter("l2ChainId");
  const l2ExchangeRecipient = m.getParameter("l2ExchangeRecipient");
  const wrappedNativeToken = m.getParameter("wrappedNativeToken");
  const yieldRecipient = m.getParameter("yieldRecipient");
  const vaultStrategyOpsLib = m.library("VaultStrategyOpsLib", {
    id: "VaultStrategyOpsLib",
  });
  const vaultBridgeLib = m.library("VaultBridgeLib", {
    id: "VaultBridgeLib",
    libraries: {
      VaultStrategyOpsLib: vaultStrategyOpsLib,
    },
  });

  const vaultImplementation = m.contract("GRVTL1TreasuryVault", [], {
    id: "VaultImplementation",
    libraries: {
      VaultStrategyOpsLib: vaultStrategyOpsLib,
      VaultBridgeLib: vaultBridgeLib,
    },
  });

  const initializeCalldata = m.encodeFunctionCall(
    vaultImplementation,
    "initialize",
    [
      deployAdmin,
      bridgeHub,
      grvtBridgeProxyFeeToken,
      l2ChainId,
      l2ExchangeRecipient,
      wrappedNativeToken,
      yieldRecipient,
    ],
    { id: "VaultInitializeCalldata" },
  );

  const vaultProxy = m.contract(
    "TransparentUpgradeableProxy",
    transparentUpgradeableProxyArtifact,
    [vaultImplementation, deployAdmin, initializeCalldata],
    { id: "VaultProxy" },
  );

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });

  return {
    vaultStrategyOpsLib,
    vaultBridgeLib,
    vaultImplementation,
    vaultProxy,
    vault,
  };
});
