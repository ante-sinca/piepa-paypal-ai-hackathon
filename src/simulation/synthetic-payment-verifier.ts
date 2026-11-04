import { randomUUID } from "node:crypto";
import type { EnvelopePayload, PaymentEvidence } from "../contracts/envelope.js";

export type SyntheticPaymentVerification = Readonly<{ accepted: boolean; reason?: string; evidence: PaymentEvidence }>;

/** Fixture-only verifier; it is intentionally incompatible with PayPal webhook and retrieval adapters. */
export class SyntheticPaymentVerificationAdapter {
  readonly provider = "synthetic-demo" as const;
  verify(envelope: EnvelopePayload, input: Readonly<{ amount?: { currency: string; value: string }; correlationId?: string }>): SyntheticPaymentVerification {
    const amount = input.amount ?? envelope.paymentIntent.acceptedAmounts.minimum;
    const correlationId = input.correlationId ?? envelope.envelopeId;
    const evidence: PaymentEvidence = { provider: this.provider, resourceId: `synthetic-payment-${randomUUID()}`, captureId: `synthetic-capture-${randomUUID()}`, correlationId, amount, status: "COMPLETED", independentlyRetrievedAt: new Date().toISOString(), isSynthetic: true };
    const expected = envelope.paymentIntent.acceptedAmounts.minimum;
    if (correlationId !== envelope.envelopeId) return { accepted: false, reason: "PAYMENT_BINDING_REJECTED", evidence };
    if (amount.currency !== expected.currency || amount.value !== expected.value) return { accepted: false, reason: "PAYMENT_BINDING_REJECTED", evidence };
    return { accepted: true, evidence };
  }
}
