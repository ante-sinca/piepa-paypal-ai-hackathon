import type { EnvelopePayload } from "../contracts/envelope.js";

export type ValidationResult = Readonly<{ valid: boolean; errors: readonly string[] }>;

const ISO_CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export function validateEnvelope(payload: EnvelopePayload, now = new Date()): ValidationResult {
  const errors: string[] = [];
  if (!IDENTIFIER.test(payload.envelopeId)) errors.push("envelopeId is not a valid opaque identifier");
  if (!IDENTIFIER.test(payload.issuerId)) errors.push("issuerId is required");
  if (!IDENTIFIER.test(payload.authorisedPartyId)) errors.push("authorisedPartyId is required");
  if (!IDENTIFIER.test(payload.nonce)) errors.push("nonce is required for replay control");
  const created = Date.parse(payload.createdAt);
  const expiry = Date.parse(payload.expiresAt);
  if (Number.isNaN(created) || Number.isNaN(expiry) || expiry <= created) errors.push("expiry must be after creation");
  if (!Number.isNaN(expiry) && expiry <= now.getTime()) errors.push("envelope has expired");
  for (const amount of [payload.paymentIntent.acceptedAmounts.minimum, payload.paymentIntent.acceptedAmounts.maximum, payload.execution.maxPayout]) {
    if (!ISO_CURRENCY.test(amount.currency)) errors.push("currency must be ISO 4217 uppercase format");
    if (!DECIMAL.test(amount.value) || amount.value === "0") errors.push("amount must be a positive decimal string");
  }
  const min = decimalToMicros(payload.paymentIntent.acceptedAmounts.minimum.value);
  const max = decimalToMicros(payload.paymentIntent.acceptedAmounts.maximum.value);
  if (payload.paymentIntent.acceptedAmounts.minimum.currency !== payload.paymentIntent.acceptedAmounts.maximum.currency || min > max) {
    errors.push("payment amount range is invalid");
  }
  if (payload.execution.simulationOnly !== true) errors.push("Stage 0 only permits simulation-only execution");
  if (!payload.execution.oneTimeAuthorisationRequired) errors.push("single-use payout authorisation is mandatory");
  if (!payload.requiredVerification.includes("PAYMENT_RESOURCE_RETRIEVED")) errors.push("independent payment retrieval is mandatory");
  if (!payload.requiredVerification.includes("HUMAN_APPROVAL_RECORDED")) errors.push("human approval evidence is mandatory");
  if (payload.permittedActions.includes("AUTHORISE_SIMULATED_PAYOUT") && !payload.execution.payoutProvider.startsWith("mock-")) {
    errors.push("Stage 0 payout provider must be explicitly mock-* ");
  }
  return { valid: errors.length === 0, errors };
}

function decimalToMicros(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}
