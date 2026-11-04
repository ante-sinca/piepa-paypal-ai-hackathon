import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  DemoWorkflowService, LocalDurableLedger, LocalProposalStore, PayPalPaymentLinkCollectionService,
  PayPalSandboxOrdersAdapter, PayPalSandboxPaymentLinksAdapter, SyntheticInstructionDraftingAgent,
  type FetchLike,
} from "../src/index.js";

const source = "Prepare a fictional demonstration instruction to collect GBP 10.00 through PayPal Sandbox for payment purpose: family housing support. Recipient display name: Ana Santos. Following verified payment evidence and explicit human approval, simulate a Philippines payout to beneficiary reference: PH-DEMO-001. Destination type: MOCK. Do not execute an actual transfer.";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(process.cwd(), ".paylink-poc-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const keys = { privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "paylink-poc-test-key" };
  const ledger = new LocalDurableLedger(join(root, "ledger.json")); const proposals = new LocalProposalStore(join(root, "proposals.json"));
  const demo = new DemoWorkflowService(ledger, proposals, new SyntheticInstructionDraftingAgent(), keys);
  const calls: { url: string; body?: string }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/v1/oauth2/token")) return response({ access_token: "sandbox-token" });
    if (url.endsWith("/v1/checkout/payment-resources")) return response({ id: "PL-TEST-001", payment_link: "https://www.sandbox.paypal.com/ncp/payment/PL-TEST-001", status: "ACTIVE", reusable: "MULTIPLE" }, 201);
    if (url.endsWith("/v1/checkout/payment-resources/PL-TEST-001")) return response({ id: "PL-TEST-001", status: "ACTIVE", reusable: "MULTIPLE" });
    throw new Error(`unexpected request ${url}`);
  };
  const links = new PayPalSandboxPaymentLinksAdapter(new PayPalSandboxOrdersAdapter({ clientId: "sandbox-id", clientSecret: "sandbox-secret" }, fetcher));
  const collection = new PayPalPaymentLinkCollectionService(ledger, proposals, keys.publicKeyPem, links, "merchant-test-001");
  return { ledger, demo, collection, calls };
}

function response(value: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => "" }; }

test("Payment Link collection requires exact approval and signature, persists the resource, and never invents a correlation field", async (t) => {
  const { ledger, demo, collection, calls } = await fixture(t);
  const proposal = await demo.generate(source);
  await assert.rejects(collection.create(proposal.proposal.proposalId, "https://example.test/return"), /HUMAN_APPROVED_SIGNED_PROPOSAL_REQUIRED/);
  await demo.approve(proposal.proposal.proposalId, "operator-paylink"); await demo.sign(proposal.proposal.proposalId);
  const created = await collection.create(proposal.proposal.proposalId, "https://example.test/return");
  assert.deepEqual({ collectionType: created.collectionType, correlationStatus: created.correlationStatus, amount: created.amount }, { collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT", correlationStatus: "PAYMENT_LINK_BINDING_UNPROVEN", amount: { currency: "GBP", value: "10.00" } });
  assert.equal((await ledger.snapshot()).instructions[0].state, "PAYMENT_PENDING");
  assert.equal((await ledger.snapshot()).paymentLinkBindings[0].paymentLinkId, "PL-TEST-001");
  const createBody = calls.find((item) => item.url.endsWith("/v1/checkout/payment-resources"))?.body ?? "";
  assert.equal(createBody.includes("custom_id"), false);
  assert.equal(createBody.includes("PH-DEMO-001"), false);
  await assert.rejects(collection.create(proposal.proposal.proposalId, "https://example.test/return"), /PAYMENT_LINK_ALREADY_CREATED_FOR_ENVELOPE/);
});

test("Payment Link resource retrieval is auditable but fails closed without unique capture correlation", async (t) => {
  const { ledger, demo, collection } = await fixture(t);
  const proposal = await demo.generate(source); await demo.approve(proposal.proposal.proposalId); await demo.sign(proposal.proposal.proposalId);
  await collection.create(proposal.proposal.proposalId, "https://example.test/return");
  const verification = await collection.verify(proposal.proposal.proposalId);
  assert.deepEqual({ state: verification.verificationState, reason: verification.reason, correlation: verification.correlationStatus }, { state: "REJECTED_FOR_AUTHORISATION", reason: "PAYMENT_LINK_BINDING_UNPROVEN", correlation: "PAYMENT_LINK_BINDING_UNPROVEN" });
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.paymentEvidence.length, 0);
  assert.equal(snapshot.authorisations.length, 0);
  assert.equal(snapshot.executionAttempts.length, 0);
  assert.equal(snapshot.auditEvents.some((event) => event.action === "VERIFY_PAYPAL_SANDBOX_PAYMENT_LINK" && event.outcome === "DENY"), true);
});
