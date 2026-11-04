import type { PayPalSandboxOrdersAdapter } from "../adapters/paypal-sandbox.js";
import type { Stage1Persistence } from "../persistence/contracts.js";

/**
 * Reconciles a webhook's referenced Order using a fresh provider retrieval.
 * It deliberately records evidence only; it cannot advance eligibility or
 * create a payout authorisation.
 */
export function createSandboxOrderEvidenceRetriever(input: Readonly<{
  ledger: Stage1Persistence;
  paypal: PayPalSandboxOrdersAdapter;
}>): (orderId: string) => Promise<void> {
  return async (orderId: string): Promise<void> => {
    const snapshot = await input.ledger.snapshot();
    const binding = snapshot.orderBindings.find((item) => item.orderId === orderId);
    if (!binding) throw new Error("Webhook references an Order without an HBIEPA binding");
    const retrieved = await input.paypal.retrieveCaptureEvidence(orderId);
    if (retrieved.evidence.correlationId !== binding.correlationId) throw new Error("Independently retrieved Order correlation does not match the binding");
    const alreadyRecorded = snapshot.paymentEvidence.some((item) => item.envelopeId === binding.envelopeId && item.evidence.captureId === retrieved.evidence.captureId);
    if (!alreadyRecorded) await input.ledger.storePaymentEvidence(binding.envelopeId, retrieved.evidence, retrieved.rawOrder);
  };
}
