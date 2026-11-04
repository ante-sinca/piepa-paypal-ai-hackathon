import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AuthorisationService, createSandboxOrderEvidenceRetriever, EnvelopeService, MockPhilippinesPayoutAdapter, PayPalSandboxOrdersAdapter, SqliteDurableLedger,
  PayPalSandboxPaymentLinksAdapter, PayPalWebhookInbox, evaluateSandboxPolicy, loadStage1Config, reconcileEnvelope,
  type EnvelopePayload, type FetchLike,
} from "../src/index.js";

const future = "2099-10-23T12:00:00.000Z";
const earlier = "2099-10-22T12:00:00.000Z";

function draft(id = "env-stage1-0001"): EnvelopePayload {
  return {
    envelopeId: id, version: "1.0", issuerId: "merchant-demo-001", authorisedPartyId: "operator-demo-001", createdAt: earlier, expiresAt: future, nonce: `nonce-${id}`,
    paymentIntent: { collectionPurpose: "Stage 1 test", acceptedAmounts: { minimum: { currency: "GBP", value: "10.00" }, maximum: { currency: "GBP", value: "10.00" } }, permittedPaymentProviders: ["paypal-sandbox"] },
    beneficiary: { beneficiaryReference: "beneficiary-demo-001", destinationType: "MOCK", destinationReference: "mock-wallet-001", destinationCountry: "PH" },
    permittedActions: ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
    requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "PAYMENT_PROVIDER_EVENT_VERIFIED", "HUMAN_APPROVAL_RECORDED"],
    authorisationPolicyRef: "policy/stage1-v1", execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency: "PHP", value: "700.00" }, oneTimeAuthorisationRequired: true }, auditReference: "audit-stage1", reconciliationReference: "recon-stage1",
  };
}

async function newLedger(): Promise<SqliteDurableLedger> {
  return new SqliteDurableLedger(join(await mkdtemp(join(process.cwd(), ".stage1-test-")), "ledger.sqlite"));
}

async function verifiedFlow(id = "env-stage1-0001") {
  const ledger = await newLedger();
  const service = new EnvelopeService(ledger);
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  await service.createUnsignedDraft(draft(id));
  assert.equal((await service.validateDraft(id, new Date("2099-10-22T13:00:00.000Z"))).valid, true);
  const signed = await service.signValidatedDraft(id, privateKey, "test-key", new Date("2099-10-22T13:00:00.000Z"));
  assert.equal((await service.verifySignedEnvelope(id, { "test-key": publicKey }, new Date("2099-10-22T13:00:00.000Z"))).valid, true);
  await service.openPaymentCollection(id);
  await ledger.bindPayPalOrder({ envelopeId: id, orderId: `ORDER-${id}`, correlationId: `corr-${id}`, expectedAmount: { currency: "GBP", value: "10.00" }, expectedMerchantId: "merchant-test-001", createdAt: earlier });
  const evidence = await ledger.storePaymentEvidence(id, { provider: "paypal-sandbox", resourceId: `ORDER-${id}`, captureId: `CAP-${id}`, correlationId: `corr-${id}`, merchantId: "merchant-test-001", amount: { currency: "GBP", value: "10.00" }, status: "COMPLETED", independentlyRetrievedAt: earlier, isSynthetic: false }, "recorded-order-fixture");
  await service.markPaymentVerified(id);
  return { ledger, service, signed, publicKey, evidence };
}

test("Stage 1 envelope lifecycle detects payload tampering, wrong keys, expiry, replay and illegal transitions", async () => {
  const { ledger, signed, publicKey } = await verifiedFlow();
  assert.equal((await new EnvelopeService(ledger).verifySignedEnvelope("env-stage1-0001", { "test-key": publicKey }, new Date("2100-01-01T00:00:00.000Z"))).valid, false);
  assert.equal(signed.signature.payloadDigest.length > 20, true);
  const altered = { ...signed, payload: { ...signed.payload, issuerId: "attacker-001" } };
  assert.equal((await import("../src/index.js")).verifyEnvelope(altered, publicKey), false);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal((await import("../src/index.js")).verifyEnvelope(signed, other), false);
  await assert.rejects(ledger.createDraft({ ...draft("env-stage1-replay"), nonce: "nonce-env-stage1-0001" }), /Duplicate envelope nonce/);
  await assert.rejects(ledger.advanceState("env-stage1-0001", "ELIGIBILITY_PENDING", "EXECUTED"), /Illegal state transition/);
});

test("payment verified does not authorise: deterministic policy rejects wrong identity, binding, amount, currency, beneficiary and synthetic evidence", async () => {
  const { ledger, evidence } = await verifiedFlow();
  const snapshot = await ledger.snapshot();
  const envelope = snapshot.instructions[0].versions[0].envelope.payload;
  const binding = snapshot.orderBindings[0];
  const deny = evaluateSandboxPolicy({ envelope, signatureValid: true, humanApprovalRecorded: true, payment: { ...evidence.evidence, resourceId: "WRONG", correlationId: "wrong-correlation", merchantId: "wrong-merchant", amount: { currency: "USD", value: "11.00" }, isSynthetic: true }, binding, intendedBeneficiaryReference: "wrong-beneficiary", intendedPayout: { currency: "PHP", value: "701.00" }, providerEligibilityEvidence: false, alreadyAuthorised: false, now: new Date("2099-10-22T13:00:00.000Z") });
  assert.equal(deny.outcome, "DENY");
  assert.equal(deny.reasons.includes("ORDER_ID_MISMATCH"), true);
  assert.equal(deny.reasons.includes("OPAQUE_CORRELATION_MISMATCH"), true);
  assert.equal(deny.reasons.includes("MERCHANT_OR_PAYEE_MISMATCH"), true);
  assert.equal(deny.reasons.includes("SYNTHETIC_PAYMENT_EVIDENCE_CANNOT_AUTHORISE"), true);
  assert.equal(deny.reasons.includes("BENEFICIARY_MISMATCH"), true);
});

test("verified merchant metadata refresh preserves immutable Order binding identity", async () => {
  const { ledger } = await verifiedFlow("env-stage1-merchant-refresh");
  await ledger.refreshPayPalOrderExpectedMerchant("env-stage1-merchant-refresh", "ORDER-env-stage1-merchant-refresh", "corr-env-stage1-merchant-refresh", "merchant-corrected-001");
  assert.equal((await ledger.getOrderBinding("env-stage1-merchant-refresh"))?.expectedMerchantId, "merchant-corrected-001");
  await assert.rejects(ledger.refreshPayPalOrderExpectedMerchant("env-stage1-merchant-refresh", "wrong-order", "corr-env-stage1-merchant-refresh", "merchant-corrected-002"), /identity cannot be changed/);
});

test("concurrent authorisation requests are constrained durably and mock execution is exactly once locally", async () => {
  const { ledger, evidence } = await verifiedFlow("env-stage1-race");
  const service = new AuthorisationService(ledger);
  const request = () => service.evaluateAndAuthorise({ envelopeId: "env-stage1-race", publicKeyValid: true, humanApprovalRecorded: true, paymentEvidence: evidence, intendedBeneficiaryReference: "beneficiary-demo-001", intendedPayout: { currency: "PHP", value: "700.00" }, providerEligibilityEvidence: true, expiresAt: future, now: new Date("2099-10-22T13:00:00.000Z") });
  const results = await Promise.allSettled([request(), request(), request(), request()]);
  const successful = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof request>>> => item.status === "fulfilled" && item.value.authorisation !== undefined);
  assert.equal(successful.length, 1);
  const authorisationId = successful[0].value.authorisation!.authorisationId;
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.authorisations.length, 1);
  const adapter = new MockPhilippinesPayoutAdapter(ledger);
  const initial = await adapter.execute(snapshot.authorisations[0], "AMBIGUOUS");
  const outcomes = await Promise.all([adapter.execute(snapshot.authorisations[0], "SUCCEEDED"), adapter.execute(snapshot.authorisations[0], "SUCCEEDED")]);
  assert.equal(initial.outcome, "AMBIGUOUS");
  assert.equal(outcomes[0].executionId, outcomes[1].executionId);
  assert.equal((await ledger.snapshot()).executionAttempts.length, 1);
  assert.equal((await ledger.snapshot()).authorisations[0].authorisationId, authorisationId);
  assert.equal((await adapter.execute(snapshot.authorisations[0], "SUCCEEDED")).outcome, "AMBIGUOUS");
  await assert.rejects(adapter.execute({ ...snapshot.authorisations[0], payoutProvider: "not-a-provider" } as unknown as typeof snapshot.authorisations[0], "SUCCEEDED"), /Attempted production/);
  const reconciliation = await reconcileEnvelope(ledger, "env-stage1-race");
  assert.equal(reconciliation.findings.includes("AMBIGUOUS_EXECUTION_OUTCOME"), true);
});

test("webhook inbox deduplicates deliveries, rejects replay/forgery configuration and labels simulator fixtures synthetic", async () => {
  const ledger = await newLedger();
  const inbox = new PayPalWebhookInbox(ledger, undefined);
  const fixture = { rawBody: "{\"id\":\"WH-1\"}", headers: { "paypal-transmission-id": "WH-1" }, source: "PAYPAL_SIMULATOR" as const };
  const first = await inbox.receive(fixture);
  const second = await inbox.receive(fixture);
  assert.equal(first.verification, "SYNTHETIC");
  assert.equal(second.duplicate, true);
  const outOfOrder = await inbox.receive({ rawBody: "{\"id\":\"WH-early\"}", headers: { "paypal-transmission-id": "WH-early" }, source: "LOCAL_FIXTURE" });
  assert.equal(outOfOrder.processing, "WAITING_FOR_RESOURCE");
  const forged = await inbox.receive({ rawBody: "{}", headers: { "paypal-transmission-id": "WH-forged", "paypal-transmission-time": new Date().toISOString() }, source: "PAYPAL_SANDBOX" });
  assert.equal(forged.accepted, false);
  const stalePaypal = new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, async () => { throw new Error("stale replay must not call PayPal"); });
  const stale = await new PayPalWebhookInbox(ledger, "webhook-id", stalePaypal).receive({ rawBody: "{}", headers: { "paypal-transmission-id": "WH-replay", "paypal-transmission-time": "2000-01-01T00:00:00.000Z" }, source: "PAYPAL_SANDBOX" });
  assert.equal(stale.accepted, false);
});

test("a signature-verified webhook still fails closed for an unbound or mismatched independently retrieved Order", async () => {
  const ledger = await newLedger();
  const now = new Date();
  const fakeFetch: FetchLike = async (url) => {
    if (url.endsWith("/v1/oauth2/token")) return { ok: true, status: 200, json: async () => ({ access_token: "test-token" }), text: async () => "" };
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) return { ok: true, status: 200, json: async () => ({ verification_status: "SUCCESS" }), text: async () => "" };
    if (url.endsWith("/v2/checkout/orders/ORDER-MISMATCH")) {
      return {
        ok: true, status: 200,
        json: async () => ({ id: "ORDER-MISMATCH", purchase_units: [{ custom_id: "wrong-correlation", payee: { merchant_id: "merchant-test-001" }, amount: { currency_code: "GBP", value: "10.00" }, payments: { captures: [{ id: "CAP-MISMATCH", status: "COMPLETED", amount: { currency_code: "GBP", value: "10.00" } }] } }] }),
        text: async () => "",
      };
    }
    throw new Error(`Unexpected PayPal request: ${url}`);
  };
  const paypal = new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, fakeFetch);
  const inbox = new PayPalWebhookInbox(ledger, "sandbox-webhook-id", paypal, createSandboxOrderEvidenceRetriever({ ledger, paypal }));
  const headers = (deliveryId: string) => ({ "paypal-transmission-id": deliveryId, "paypal-transmission-time": now.toISOString() });
  const unbound = await inbox.receive({ rawBody: JSON.stringify({ resource: { supplementary_data: { related_ids: { order_id: "ORDER-NOT-BOUND" } } } }), headers: headers("WH-UNBOUND"), source: "PAYPAL_SANDBOX", receivedAt: now });
  assert.deepEqual({ accepted: unbound.accepted, verification: unbound.verification, processing: unbound.processing }, { accepted: false, verification: "VERIFIED", processing: "FAILED" });

  await ledger.createDraft(draft("env-webhook-mismatch"));
  await ledger.bindPayPalOrder({ envelopeId: "env-webhook-mismatch", orderId: "ORDER-MISMATCH", correlationId: "expected-correlation", expectedAmount: { currency: "GBP", value: "10.00" }, expectedMerchantId: "merchant-test-001", createdAt: earlier });
  const mismatched = await inbox.receive({ rawBody: JSON.stringify({ resource: { supplementary_data: { related_ids: { order_id: "ORDER-MISMATCH" } } } }), headers: headers("WH-MISMATCH"), source: "PAYPAL_SANDBOX", receivedAt: now });
  assert.deepEqual({ accepted: mismatched.accepted, verification: mismatched.verification, processing: mismatched.processing }, { accepted: false, verification: "VERIFIED", processing: "FAILED" });
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.paymentEvidence.length, 0);
  assert.equal(snapshot.authorisations.length, 0);
});

test("sandbox REST adapters bind Orders custom_id, preserve caller idempotency, never accept live configuration, and Payment Links do not invent custom_id correlation", async () => {
  const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
  const fakeFetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (url.endsWith("/v1/oauth2/token")) return { ok: true, status: 200, json: async () => ({ access_token: "test-token" }), text: async () => "" };
    if (url.endsWith("/v2/checkout/orders")) return { ok: true, status: 201, json: async () => ({ id: "ORDER-1", links: [] }), text: async () => "" };
    return { ok: true, status: 201, json: async () => ({ id: "PLB-1", reusable: "MULTIPLE" }), text: async () => "" };
  };
  const orders = new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, fakeFetch);
  await orders.createOrder({ correlationId: "corr-1", amount: { currency: "GBP", value: "10.00" }, returnUrl: "https://example.test/return", cancelUrl: "https://example.test/cancel", requestId: "stable-order-request-id" });
  await new PayPalSandboxPaymentLinksAdapter(orders).createReusableLink({ name: "test", amount: { currency: "GBP", value: "10.00" }, returnUrl: "https://example.test/return" });
  await new PayPalSandboxPaymentLinksAdapter(orders).getPaymentLink("PLB-1");
  assert.equal(calls.every((call) => call.url.startsWith("https://api-m.sandbox.paypal.com/")), true);
  assert.match(calls.find((call) => call.url.endsWith("/v2/checkout/orders"))!.body!, /"custom_id":"corr-1"/);
  assert.equal(calls.find((call) => call.url.endsWith("/v2/checkout/orders"))!.headers["PayPal-Request-Id"], "stable-order-request-id");
  assert.equal(calls.find((call) => call.url.endsWith("payment-resources"))!.body!.includes("custom_id"), false);
  assert.equal(calls.some((call) => call.url.endsWith("payment-resources/PLB-1")), true);
  assert.throws(() => loadStage1Config({ HBIEPA_OPERATION_MODE: "live" }));
  assert.throws(() => loadStage1Config({ PAYPAL_API_ORIGIN: "https://api.paypal.com" }));
  assert.throws(() => new PayPalSandboxOrdersAdapter({ clientId: "", clientSecret: "" }));
  const transportFailure = new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, async () => {
    const error = Object.assign(new Error("network failure"), { cause: { code: "ECONNRESET" } });
    throw error;
  });
  await assert.rejects(transportFailure.verifySandboxAuthentication(), /OAuth token request \(ECONNRESET\)/);
});
