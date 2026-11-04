import { randomUUID } from "node:crypto";
import type { EnvelopePayload, PaymentEvidence } from "../contracts/envelope.js";
import type { PayPalOrderBinding } from "../persistence/local-ledger.js";

export type SandboxPolicyDecision = Readonly<{
  decisionId: string;
  outcome: "ALLOW_SIMULATION" | "DENY";
  reasons: readonly string[];
  createdAt: string;
}>;

const micros = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
};

/** Deterministic and deliberately limited to sandbox mock-execution eligibility. */
export function evaluateSandboxPolicy(input: Readonly<{
  envelope: EnvelopePayload;
  signatureValid: boolean;
  humanApprovalRecorded: boolean;
  payment: PaymentEvidence;
  binding?: PayPalOrderBinding;
  intendedBeneficiaryReference: string;
  intendedPayout: { currency: string; value: string };
  providerEligibilityEvidence: boolean;
  alreadyAuthorised: boolean;
  now?: Date;
}>): SandboxPolicyDecision {
  const reasons: string[] = [];
  const at = input.now ?? new Date();
  if (!input.signatureValid) reasons.push("ENVELOPE_INTEGRITY_FAILED");
  if (Date.parse(input.envelope.expiresAt) <= at.getTime()) reasons.push("ENVELOPE_EXPIRED");
  if (!input.humanApprovalRecorded) reasons.push("HUMAN_APPROVAL_MISSING");
  if (input.payment.isSynthetic) reasons.push("SYNTHETIC_PAYMENT_EVIDENCE_CANNOT_AUTHORISE");
  if (input.payment.provider !== "paypal-sandbox" || input.payment.status !== "COMPLETED") reasons.push("PAYMENT_NOT_A_COMPLETED_SANDBOX_CAPTURE");
  if (!input.payment.captureId) reasons.push("CAPTURE_ID_MISSING");
  if (!input.binding) reasons.push("PAYMENT_BINDING_MISSING");
  if (input.binding && input.payment.resourceId !== input.binding.orderId) reasons.push("ORDER_ID_MISMATCH");
  if (input.binding && input.payment.correlationId !== input.binding.correlationId) reasons.push("OPAQUE_CORRELATION_MISMATCH");
  if (input.binding?.expectedMerchantId && input.payment.merchantId !== input.binding.expectedMerchantId) reasons.push("MERCHANT_OR_PAYEE_MISMATCH");
  const minimum = input.envelope.paymentIntent.acceptedAmounts.minimum;
  const maximum = input.envelope.paymentIntent.acceptedAmounts.maximum;
  if (input.payment.amount.currency !== minimum.currency || input.payment.amount.currency !== maximum.currency) reasons.push("PAYMENT_CURRENCY_MISMATCH");
  else if (micros(input.payment.amount.value) < micros(minimum.value) || micros(input.payment.amount.value) > micros(maximum.value)) reasons.push("PAYMENT_AMOUNT_MISMATCH");
  if (input.intendedBeneficiaryReference !== input.envelope.beneficiary.beneficiaryReference) reasons.push("BENEFICIARY_MISMATCH");
  if (input.intendedPayout.currency !== input.envelope.execution.maxPayout.currency || micros(input.intendedPayout.value) > micros(input.envelope.execution.maxPayout.value)) reasons.push("PAYOUT_LIMIT_MISMATCH");
  if (input.envelope.execution.payoutProvider !== "mock-philippines" || input.envelope.execution.simulationOnly !== true) reasons.push("PRODUCTION_PAYOUT_PROHIBITED");
  if (!input.providerEligibilityEvidence) reasons.push("SANDBOX_SIMULATION_ELIGIBILITY_EVIDENCE_MISSING");
  if (input.alreadyAuthorised) reasons.push("SINGLE_USE_AUTHORISATION_ALREADY_EXISTS");
  return { decisionId: randomUUID(), outcome: reasons.length === 0 ? "ALLOW_SIMULATION" : "DENY", reasons, createdAt: at.toISOString() };
}
