import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * NativeIngressModule
 *
 * Purpose:
 * - Deploy NativeToWrappedIngress for canonical external ETH ingress.
 *
 * Parameters (NativeIngressModule.*):
 * - wrappedNativeToken: canonical wrapped-native token address (e.g. WETH).
 * - vaultProxy: existing GRVTDeFiVault proxy address.
 */
export default buildModule("NativeIngressModule", (m) => {
  const wrappedNativeToken = m.getParameter("wrappedNativeToken");
  const vaultProxy = m.getParameter("vaultProxy");

  const nativeIngress = m.contract(
    "NativeToWrappedIngress",
    [wrappedNativeToken, vaultProxy],
    { id: "NativeIngress" },
  );

  return { nativeIngress };
});

