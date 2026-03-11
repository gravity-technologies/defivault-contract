import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * NativeBridgeGatewayClaimFailedDepositModule
 *
 * Purpose:
 * - Execute an external zkSync shared-bridge `claimFailedDeposit` for a native bridge request.
 * - Immediately normalize the claimed ETH back into wrapped-native through `NativeBridgeGateway`.
 *
 * Parameters (NativeBridgeGatewayClaimFailedDepositModule.*):
 * - sharedBridge: zkSync shared bridge address exposing `claimFailedDeposit`.
 * - nativeBridgeGatewayProxy: existing NativeBridgeGateway proxy address.
 * - chainId: target L2 chain id of the failed deposit.
 * - amount: native ETH amount to reclaim.
 * - bridgeTxHash: canonical L2 tx hash returned during `bridgeNativeToL2`.
 * - l2BatchNumber: proving batch number for the failed deposit.
 * - l2MessageIndex: proving message index for the failed deposit.
 * - l2TxNumberInBatch: proving tx index within the batch.
 * - merkleProof: proving merkle proof for the failed deposit.
 */
export default buildModule(
  "NativeBridgeGatewayClaimFailedDepositModule",
  (m) => {
    const sharedBridge = m.getParameter("sharedBridge");
    const nativeBridgeGatewayProxy = m.getParameter("nativeBridgeGatewayProxy");
    const chainId = m.getParameter("chainId");
    const amount = m.getParameter("amount");
    const bridgeTxHash = m.getParameter("bridgeTxHash");
    const l2BatchNumber = m.getParameter("l2BatchNumber");
    const l2MessageIndex = m.getParameter("l2MessageIndex");
    const l2TxNumberInBatch = m.getParameter("l2TxNumberInBatch");
    const merkleProof = m.getParameter("merkleProof", []);

    const gateway = m.contractAt(
      "NativeBridgeGateway",
      nativeBridgeGatewayProxy,
      {
        id: "NativeBridgeGateway",
      },
    );
    const sharedBridgeContract = m.contractAt("IL1SharedBridge", sharedBridge, {
      id: "SharedBridge",
    });

    const claim = m.call(
      sharedBridgeContract,
      "claimFailedDeposit",
      [
        chainId,
        nativeBridgeGatewayProxy,
        "0x0000000000000000000000000000000000000000",
        amount,
        bridgeTxHash,
        l2BatchNumber,
        l2MessageIndex,
        l2TxNumberInBatch,
        merkleProof,
      ],
      {
        id: "ClaimFailedNativeDeposit",
      },
    );

    m.call(gateway, "recoverClaimedNativeDeposit", [bridgeTxHash], {
      id: "RecoverClaimedNativeDeposit",
      after: [claim],
    });

    return { sharedBridgeContract, gateway };
  },
);
