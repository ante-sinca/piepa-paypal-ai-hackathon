import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { signEnvelope, validateEnvelope, verifyEnvelope, type EnvelopePayload } from "../src/index.js";

function draft(): EnvelopePayload {
  return {
    envelopeId: "env-stage0-0001",
    version: "1.0",
    issuerId: "merchant-demo-001",
    authorisedPartyId: "operator-demo-001",
    createdAt: "2026-10-22T10:00:00.000Z",
    expiresAt: "2026-10-23T10:00:00.000Z",
    nonce: "nonce-stage0-0001",
    paymentIntent: {
      collectionPurpose: "Demo collection",
      acceptedAmounts: { minimum: { currency: "GBP", value: "10.00" }, maximum: { currency: "GBP", value: "10.00" } },
      permittedPaymentProviders: ["paypal-sandbox"],
    },
    beneficiary: { beneficiaryReference: "beneficiary-demo-001", destinationType: "MOCK", destinationReference: "mock-wallet-001", destinationCountry: "PH" },
    permittedActions: ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
    requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "PAYMENT_PROVIDER_EVENT_VERIFIED", "HUMAN_APPROVAL_RECORDED"],
    authorisationPolicyRef: "policy/demo-v1",
    execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency: "PHP", value: "700.00" }, oneTimeAuthorisationRequired: true },
    auditReference: "audit-demo-001",
    reconciliationReference: "recon-demo-001",
  };
}

test("valid envelope is signed and a substituted payload is rejected", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signEnvelope(draft(), privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "stage0-test-key");
  assert.equal(verifyEnvelope(signed, publicKey.export({ type: "spki", format: "pem" }).toString()), true);
  const substituted = { ...signed, payload: { ...signed.payload, issuerId: "attacker-001" } };
  assert.equal(verifyEnvelope(substituted, publicKey.export({ type: "spki", format: "pem" }).toString()), false);
});

test("validation fails closed on expiry and a non-mock Stage 0 payout provider", () => {
  const expired = { ...draft(), expiresAt: "2026-10-21T10:00:00.000Z" };
  assert.equal(validateEnvelope(expired, new Date("2026-10-22T10:00:00.000Z")).valid, false);
  const nonMock = { ...draft(), execution: { ...draft().execution, payoutProvider: "paypal-payouts" } };
  assert.equal(validateEnvelope(nonMock, new Date("2026-10-22T10:00:00.000Z")).valid, false);
});
