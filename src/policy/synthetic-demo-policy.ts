import { randomUUID } from "node:crypto";
import type { EnvelopePayload, PaymentEvidence } from "../contracts/envelope.js";
import type { SandboxPolicyDecision } from "./engine.js";

const micros = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
};

/**
 * Explicitly isolated policy for local fixtures. This is not a PayPal policy,
 * never consumes webhook data, and cannot be selected by the real adapter.
 */
export function evaluateSyntheticDemoPolicy(input: Readonly<{
  envelope: EnvelopePayload;
  signatureValid: boolean;
  humanApprovalRecorded: boolean;
  payment: PaymentEvidence;
  intendedBeneficiaryReference: string;
  intendedPayout: { currency: string; value: string };
  alreadyAuthorised: boolean;
  now?: Date;
}>): SandboxPolicyDecision {
  const reasons: string[] = [];
  const at = input.now ?? new Date();
  if (!input.signatureValid) reasons.push("ENVELOPE_INTEGRITY_FAILED");
  if (Date.parse(input.envelope.expiresAt) <= at.getTime()) reasons.push("ENVELOPE_EXPIRED");
  if (!input.humanApprovalRecorded) reasons.push("HUMAN_APPROVAL_MISSING");
  if (!input.payment.isSynthetic || input.payment.provider !== "synthetic-demo" || input.payment.status !== "COMPLETED") reasons.push("SYNTHETIC_DEMO_EVIDENCE_REQUIRED");
  const minimum = input.envelope.paymentIntent.acceptedAmounts.minimum;
  const maximum = input.envelope.paymentIntent.acceptedAmounts.maximum;
  if (input.payment.amount.currency !== minimum.currency || input.payment.amount.currency !== maximum.currency) reasons.push("PAYMENT_CURRENCY_MISMATCH");
  else if (micros(input.payment.amount.value) < micros(minimum.value) || micros(input.payment.amount.value) > micros(maximum.value)) reasons.push("PAYMENT_AMOUNT_MISMATCH");
  if (input.payment.correlationId !== input.envelope.envelopeId) reasons.push("PAYMENT_BINDING_REJECTED");
  if (input.intendedBeneficiaryReference !== input.envelope.beneficiary.beneficiaryReference) reasons.push("BENEFICIARY_MISMATCH");
  if (input.intendedPayout.currency !== input.envelope.execution.maxPayout.currency || micros(input.intendedPayout.value) > micros(input.envelope.execution.maxPayout.value)) reasons.push("PAYOUT_LIMIT_MISMATCH");
  if (input.envelope.execution.simulationOnly !== true || input.envelope.execution.payoutProvider !== "mock-philippines") reasons.push("PRODUCTION_PAYOUT_PROHIBITED");
  if (input.alreadyAuthorised) reasons.push("SINGLE_USE_AUTHORISATION_ALREADY_EXISTS");
  return { decisionId: randomUUID(), outcome: reasons.length ? "DENY" : "ALLOW_SIMULATION", reasons, createdAt: at.toISOString() };
}
