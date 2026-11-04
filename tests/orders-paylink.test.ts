import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  DemoWorkflowService, LocalDurableLedger, LocalProposalStore, PayPalOrdersPayLinkService,
  PayPalSandboxOrdersAdapter, SyntheticInstructionDraftingAgent, type FetchLike,
} from "../src/index.js";

const source = "Prepare a fictional demonstration instruction to collect GBP 10.00 through PayPal Sandbox for payment purpose: family housing support. Recipient display name: Ana Santos. Following verified payment evidence and explicit human approval, simulate a Philippines payout to beneficiary reference: PH-DEMO-001. Destination type: MOCK. Do not execute an actual transfer.";
type Fault = "merchant" | "amount" | "currency" | "correlation" | "incomplete" | "completed" | "voided" | "not-found";
type CreationFault = "oauth-failure" | "oauth-timeout" | "orders-timeout" | "transport-once" | "ambiguous-once" | "preflight-failure";

async function fixture(t: test.TestContext, fault?: Fault, publicKeyOverride?: string, creationFault?: CreationFault) {
  const root = await mkdtemp(join(process.cwd(), ".orders-paylink-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519"); const keys = { privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "orders-paylink-test-key" };
  const ledger = new LocalDurableLedger(join(root, "ledger.json")); const proposals = new LocalProposalStore(join(root, "proposals.json")); const demo = new DemoWorkflowService(ledger, proposals, new SyntheticInstructionDraftingAgent(), keys);
  let created = 0; let captured = false; let correlation = ""; let creationAttempts = 0;
  const fetcher: FetchLike = async (url, init) => {
    if (url.endsWith("/v1/oauth2/token")) {
      if (creationFault === "oauth-timeout") return await new Promise<never>(() => undefined);
      if (creationFault === "oauth-failure") return response({}, 401);
      return response({ access_token: "sandbox-token" });
    }
    if (url.endsWith("/v2/checkout/orders") && init.method === "POST") {
      creationAttempts += 1; correlation = JSON.parse(init.body ?? "{}").purchase_units?.[0]?.custom_id ?? "";
      if (creationFault === "orders-timeout") return await new Promise<never>(() => undefined);
      if (creationFault === "transport-once" && creationAttempts === 1) throw Object.assign(new Error("transport"), { code: "ECONNRESET" });
      if (creationFault === "ambiguous-once" && creationAttempts === 1) { created += 1; throw Object.assign(new Error("ambiguous transport"), { code: "ECONNRESET" }); }
      if (creationFault !== "ambiguous-once" || creationAttempts === 1) created += 1;
      return response({ id: "ORDER-TEST-001", status: "CREATED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST-001" }] }, 201);
    }
    if (url.endsWith("/v2/checkout/orders/ORDER-TEST-001/capture")) { captured = true; return response({ id: "ORDER-TEST-001", status: "COMPLETED" }); }
    if (url.endsWith("/v2/checkout/orders/ORDER-TEST-001")) {
      if (fault === "not-found") return response({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." }, 404);
      const value = fault === "amount" ? "11.00" : "10.00"; const currency = fault === "currency" ? "USD" : "GBP"; const merchant = fault === "merchant" ? "merchant-wrong" : "merchant-test"; const returnedCorrelation = fault === "correlation" ? "wrong-correlation" : correlation;
      const status = fault === "incomplete" ? "CREATED" : fault === "completed" ? "COMPLETED" : fault === "voided" ? "VOIDED" : captured ? "COMPLETED" : "APPROVED";
      const hasCapture = captured || fault === "completed";
      return response({ id: "ORDER-TEST-001", status, purchase_units: [{ custom_id: returnedCorrelation, payee: { merchant_id: merchant }, amount: { currency_code: currency, value }, payments: hasCapture ? { captures: [{ id: "CAP-TEST-001", status: "COMPLETED", amount: { currency_code: currency, value }, custom_id: returnedCorrelation }] } : undefined }] });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const timeout = creationFault?.includes("timeout") ? 1_000 : undefined;
  const service = new PayPalOrdersPayLinkService(ledger, proposals, publicKeyOverride ?? keys.publicKeyPem, new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, fetcher, timeout), "merchant-test", creationFault === "preflight-failure" ? async () => ({ status: "FAIL", reasons: ["CLIENT_ID_FINGERPRINT_MISMATCH"] }) : undefined);
  return { ledger, demo, service, getCreated: () => created };
}
function response(value: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => "" }; }
async function signed(t: test.TestContext, fault?: Fault, key?: string, creationFault?: CreationFault) { const result = await fixture(t, fault, key, creationFault); const proposal = await result.demo.generate(source); await result.demo.approve(proposal.proposal.proposalId, "operator-orders"); await result.demo.sign(proposal.proposal.proposalId); return { ...result, proposalId: proposal.proposal.proposalId }; }

test("Orders pay-link reserves one opaque session, binds one Order, and rejects enumeration, replay, and duplicate creation", async (t) => {
  const { ledger, service, proposalId, getCreated } = await signed(t);
  const session = await service.create(proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.equal(session.recovery, "CREATED"); if (!session.sessionToken || !session.sessionPath) throw new Error("Expected a newly-created session token");
  assert.match(session.sessionPath, /^\/pay\/[A-Za-z0-9_-]{43}$/); assert.equal(session.sessionPath.includes("PH-DEMO"), false);
  const view = await service.publicSession(session.sessionToken); assert.deepEqual(view.amount, { currency: "GBP", value: "10.00" }); assert.equal(view.checkoutPath, `${session.sessionPath}/checkout`);
  assert.equal(await service.checkoutUrl(session.sessionToken), session.approvalUrl);
  const recovered = await service.create(proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.equal(recovered.recovery, "RECOVERED_READY"); assert.equal(recovered.sessionPath, undefined); assert.equal(recovered.approvalUrl, session.approvalUrl);
  await assert.rejects(service.publicSession("x".repeat(43)), /NOT_FOUND/);
  await assert.rejects(service.publicSession(session.sessionToken, new Date("2099-01-01T00:00:00.000Z")), /EXPIRED/);
  const snapshot = await ledger.snapshot(); assert.equal(snapshot.orderBindings.length, 1); assert.equal(snapshot.orderPaymentSessions.length, 1); assert.equal(snapshot.orderPaymentSessions[0].sessionTokenDigest.includes(session.sessionToken), false); assert.equal(snapshot.orderPaymentSessions[0].applicationClientIdFingerprint, new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }).clientIdFingerprint); assert.match(snapshot.auditEvents.at(-1)?.action ?? "", /^INITIAL_PAYPAL_ORDER_RETRIEVAL_/); assert.equal(getCreated(), 1);
});

test("Sandbox preflight is read-only and reports authenticated Sandbox readiness", async () => {
  let oauthCalls = 0; let orderCalls = 0;
  const adapter = new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, async (url) => {
    if (url.endsWith("/v1/oauth2/token")) { oauthCalls += 1; return response({ access_token: "sandbox-token", app_id: "APP-TEST-001" }); }
    orderCalls += 1; throw new Error("Orders endpoint must not be called by preflight");
  });
  const pass = await adapter.preflight({ expectedMerchantId: "merchant-test" });
  assert.deepEqual(pass, { status: "PASS", display: "PAYPAL SANDBOX PREFLIGHT: PASS", endpoint: "https://api-m.sandbox.paypal.com", clientIdFingerprint: adapter.clientIdFingerprint, applicationId: "APP-TEST-001", expectedMerchantId: "merchant-test", reasons: [] });
  assert.equal(oauthCalls, 1); assert.equal(orderCalls, 0);
});

test("Orders pay-link inspects existing provider Orders read-only for checkout recovery", async (t) => {
  const created = await signed(t, "incomplete"); const createdSession = await created.service.create(created.proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.deepEqual(createdSession.initialInspection, { availability: "CHECKOUT_READY", providerStatus: "CREATED", captureExists: false });
  assert.deepEqual(await created.service.inspect(created.proposalId), { availability: "CHECKOUT_READY", providerStatus: "CREATED", captureExists: false });
  await assert.rejects(created.service.verifyAndCapture(created.proposalId), /PAYPAL_ORDER_VERIFICATION_MISMATCH/);
  assert.equal((await created.ledger.snapshot()).paymentEvidence.length, 0);

  const approved = await signed(t); await approved.service.create(approved.proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.deepEqual(await approved.service.inspect(approved.proposalId), { availability: "PAYMENT_APPROVED", providerStatus: "APPROVED", captureExists: false });

  const completed = await signed(t, "completed"); await completed.service.create(completed.proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.deepEqual(await completed.service.inspect(completed.proposalId), { availability: "PAYMENT_COMPLETED", providerStatus: "COMPLETED", captureExists: true });

  const unusable = await signed(t, "voided"); await unusable.service.create(unusable.proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.deepEqual(await unusable.service.inspect(unusable.proposalId), { availability: "ORDER_UNUSABLE", providerStatus: "VOIDED", captureExists: false });

  const mismatch = await signed(t, "amount"); await mismatch.service.create(mismatch.proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.deepEqual(await mismatch.service.inspect(mismatch.proposalId), { availability: "ORDER_BINDING_MISMATCH", providerStatus: "APPROVED", captureExists: false });
  assert.deepEqual(await mismatch.service.inspect(mismatch.proposalId, new Date("2099-01-01T00:00:00.000Z")), { availability: "PAYMENT_SESSION_INVALID_OR_EXPIRED", captureExists: false });

  const missing = await signed(t, "not-found"); const missingSession = await missing.service.create(missing.proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.deepEqual(missingSession.initialInspection, { availability: "ORDER_NOT_FOUND", providerFailure: "PAYPAL_RESOURCE_NOT_FOUND", captureExists: false });
  assert.deepEqual(await missing.service.inspect(missing.proposalId), { availability: "ORDER_NOT_FOUND", providerFailure: "PAYPAL_RESOURCE_NOT_FOUND", captureExists: false });
  assert.equal(missing.getCreated(), 1);
});

test("Orders capture verification gates authentic evidence, single-use authorisation, simulation and reconciliation", async (t) => {
  const { ledger, service, proposalId } = await signed(t); await service.create(proposalId, "https://example.test/return", "https://example.test/cancel");
  const evidence = await service.verifyAndCapture(proposalId); assert.equal(evidence.evidence.isSynthetic, false); assert.equal(evidence.evidence.captureId, "CAP-TEST-001");
  const repeated = await service.verifyAndCapture(proposalId); assert.equal(repeated.evidenceId, evidence.evidenceId);
  const authorisation = await service.authoriseSimulation(proposalId); const done = await service.executeSimulation(proposalId);
  assert.equal(done.reconciliation.status, "RECONCILED"); assert.equal((await ledger.getInstruction(authorisation.envelopeId))?.state, "RECONCILED");
  const duplicate = await service.executeSimulation(proposalId); assert.equal(duplicate.execution.executionId, done.execution.executionId); assert.equal((await ledger.snapshot()).executionAttempts.length, 1);
});

for (const fault of ["merchant", "amount", "currency", "correlation", "incomplete"] as const) {
  test(`Orders capture fails closed for ${fault} provider evidence`, async (t) => {
    const { ledger, service, proposalId } = await signed(t, fault); await service.create(proposalId, "https://example.test/return", "https://example.test/cancel");
    await assert.rejects(service.verifyAndCapture(proposalId), /PAYPAL_ORDER_VERIFICATION_MISMATCH/); assert.equal((await ledger.snapshot()).paymentEvidence.length, 0);
  });
}

test("Orders payment session rejects unapproved, invalid-signature, and expired instruction paths", async (t) => {
  const original = await fixture(t); const proposal = await original.demo.generate(source);
  await assert.rejects(original.service.create(proposal.proposal.proposalId, "https://example.test/return", "https://example.test/cancel"), /HUMAN_APPROVED_SIGNED_PROPOSAL_REQUIRED/);
  const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(); const tampered = await signed(t, undefined, wrong);
  await assert.rejects(tampered.service.create(tampered.proposalId, "https://example.test/return", "https://example.test/cancel"), /SIGNATURE_INVALID_OR_EXPIRED/);
});

test("Orders pay-link safely retries an ambiguous transport failure with its reserved request identity", async (t) => {
  const { ledger, service, proposalId, getCreated } = await signed(t, undefined, undefined, "transport-once");
  await assert.rejects(service.create(proposalId, "https://example.test/return", "https://example.test/cancel"), /PAYMENT_SESSION_OUTCOME_REQUIRES_VERIFICATION/);
  assert.equal((await ledger.snapshot()).orderPaymentSessions[0]?.status, "PENDING_ORDER");
  const recovered = await service.create(proposalId, "https://example.test/return", "https://example.test/cancel");
  assert.equal(recovered.recovery, "RECOVERED_READY"); assert.equal(recovered.sessionPath, undefined); assert.equal(getCreated(), 1);
  assert.equal((await ledger.snapshot()).paymentEvidence.length, 0);
});

test("Orders pay-link preserves ambiguous and timeout outcomes for verification without payment advancement", async (t) => {
  for (const failure of ["oauth-timeout", "orders-timeout", "ambiguous-once"] as const) {
    const { ledger, service, proposalId, getCreated } = await signed(t, undefined, undefined, failure);
    await assert.rejects(service.create(proposalId, "https://example.test/return", "https://example.test/cancel"), /PAYMENT_SESSION_OUTCOME_REQUIRES_VERIFICATION/);
    const snapshot = await ledger.snapshot(); assert.equal(snapshot.orderPaymentSessions[0]?.status, "PENDING_ORDER"); assert.equal(snapshot.paymentEvidence.length, 0);
    if (failure === "ambiguous-once") { const recovered = await service.create(proposalId, "https://example.test/return", "https://example.test/cancel"); assert.equal(recovered.recovery, "RECOVERED_READY"); assert.equal(getCreated(), 1); }
  }
});

test("Orders pay-link reports OAuth rejection without creating an Order", async (t) => {
  const { ledger, service, proposalId, getCreated } = await signed(t, undefined, undefined, "oauth-failure");
  await assert.rejects(service.create(proposalId, "https://example.test/return", "https://example.test/cancel"), /Unable to obtain PayPal sandbox access token/);
  assert.equal((await ledger.snapshot()).orderPaymentSessions[0]?.status, "PENDING_ORDER"); assert.equal(getCreated(), 0);
});

test("Orders pay-link blocks a new provider Order when the mandatory preflight fails", async (t) => {
  const { ledger, service, proposalId, getCreated } = await signed(t, undefined, undefined, "preflight-failure");
  await assert.rejects(service.create(proposalId, "https://example.test/return", "https://example.test/cancel"), /PAYPAL_SANDBOX_PREFLIGHT_FAILED:CLIENT_ID_FINGERPRINT_MISMATCH/);
  assert.equal(getCreated(), 0); assert.equal((await ledger.snapshot()).orderPaymentSessions[0]?.status, "PENDING_ORDER");
});
