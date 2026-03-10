import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { transparentUpgradeableProxyArtifact } from "./shared/transparentProxyArtifact.js";

/**
 * NativeGatewaysModule
 *
 * Purpose:
 * - Deploy NativeVaultGateway for canonical external ETH -> wrapped-native vault entry.
 * - Deploy NativeBridgeGateway implementation + TransparentUpgradeableProxy for native L1 -> L2 bridge
 *   execution and failed-deposit recovery.
 * - Configure the vault to use the deployed NativeBridgeGateway proxy.
 *
 * Parameters (NativeGatewaysModule.*):
 * - wrappedNativeToken: canonical wrapped-native token address (e.g. WETH).
 * - baseToken: GRVT base token address used for `mintValue`.
 * - bridgeHub: L1 zkSync BridgeHub address.
 * - vaultProxy: existing GRVTL1TreasuryVault proxy address.
 * - proxyAdminOwner: owner of the native bridge gateway proxy's ProxyAdmin.
 */
export default buildModule("NativeGatewaysModule", (m) => {
  const wrappedNativeToken = m.getParameter("wrappedNativeToken");
  const baseToken = m.getParameter("baseToken");
  const bridgeHub = m.getParameter("bridgeHub");
  const vaultProxy = m.getParameter("vaultProxy");
  const proxyAdminOwner = m.getParameter("proxyAdminOwner");

  const nativeVaultGateway = m.contract(
    "NativeVaultGateway",
    [wrappedNativeToken, vaultProxy],
    { id: "NativeVaultGateway" },
  );

  const nativeBridgeGatewayImplementation = m.contract(
    "NativeBridgeGateway",
    [],
    {
      id: "NativeBridgeGatewayImplementation",
    },
  );
  const initializeCalldata = m.encodeFunctionCall(
    nativeBridgeGatewayImplementation,
    "initialize",
    [wrappedNativeToken, baseToken, bridgeHub, vaultProxy],
    { id: "NativeBridgeGatewayInitializeCalldata" },
  );
  const nativeBridgeGatewayProxy = m.contract(
    "TransparentUpgradeableProxy",
    transparentUpgradeableProxyArtifact,
    [nativeBridgeGatewayImplementation, proxyAdminOwner, initializeCalldata],
    { id: "NativeBridgeGatewayProxy" },
  );
  const nativeBridgeGateway = m.contractAt(
    "NativeBridgeGateway",
    nativeBridgeGatewayProxy,
    { id: "NativeBridgeGateway" },
  );

  const vault = m.contractAt("GRVTL1TreasuryVault", vaultProxy, {
    id: "Vault",
  });

  m.call(vault, "setNativeBridgeGateway", [nativeBridgeGateway], {
    id: "SetNativeBridgeGateway",
  });

  return {
    nativeVaultGateway,
    nativeBridgeGatewayImplementation,
    nativeBridgeGatewayProxy,
    nativeBridgeGateway,
    vault,
  };
});
