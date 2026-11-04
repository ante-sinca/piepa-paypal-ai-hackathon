import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AuthorisationService, DemoWorkflowService, EnvelopeService, LocalDurableLedger, LocalProposalStore, MockPhilippinesPayoutAdapter, SyntheticInstructionDraftingAgent, TransactionStatusService, reconcileEnvelope } from "../src/index.js";

const source = "Prepare a fictional demonstration instruction to collect GBP 1.00 through PayPal Sandbox for payment purpose: family housing support. Recipient display name: Ana Santos. Following verified payment evidence and explicit human approval, simulate a Philippines payout to beneficiary reference: PH-DEMO-001. Destination type: MOCK. Do not execute an actual transfer.";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(process.cwd(), ".transaction-status-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519"); const keys = { privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "status-test" };
  const ledger = new LocalDurableLedger(join(root, "ledger.json")); const proposals = new LocalProposalStore(join(root, "proposals.json")); const workflow = new DemoWorkflowService(ledger, proposals, new SyntheticInstructionDraftingAgent(), keys);
  const generated = await workflow.generate(source); await workflow.approve(generated.proposal.proposalId, "operator-status"); await workflow.sign(generated.proposal.proposalId);
  return { ledger, proposals, workflow, keys, proposalId: generated.proposal.proposalId, envelope: generated.proposal.envelope };
}

test("authoritative status projects one complete genuine sandbox record into a reconciled receipt", async (t) => {
  const { ledger, proposals, keys, proposalId, envelope } = await fixture(t); const id = envelope.envelopeId;
  await ledger.bindPayPalOrder({ envelopeId: id, orderId: "ORDER-STATUS-001", correlationId: "corr-status-001", expectedAmount: { currency: "GBP", value: "1.00" }, expectedMerchantId: "merchant-status", createdAt: new Date().toISOString() });
  await new EnvelopeService(ledger).openPaymentCollection(id);
  const evidence = await ledger.storePaymentEvidence(id, { provider: "paypal-sandbox", resourceId: "ORDER-STATUS-001", captureId: "CAP-STATUS-001", correlationId: "corr-status-001", merchantId: "merchant-status", amount: { currency: "GBP", value: "1.00" }, status: "COMPLETED", independentlyRetrievedAt: new Date().toISOString(), isSynthetic: false }, "fixture-provider-response");
  await new EnvelopeService(ledger).markPaymentVerified(id);
  const authResult = await new AuthorisationService(ledger).evaluateAndAuthorise({ envelopeId: id, publicKeyValid: true, humanApprovalRecorded: true, paymentEvidence: evidence, intendedBeneficiaryReference: envelope.beneficiary.beneficiaryReference, intendedPayout: envelope.execution.maxPayout, providerEligibilityEvidence: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(authResult.authorisation); await new MockPhilippinesPayoutAdapter(ledger).execute(authResult.authorisation!, "SUCCEEDED"); await reconcileEnvelope(ledger, id); await ledger.advanceState(id, "EXECUTED", "RECONCILED");
  const status = await new TransactionStatusService(ledger, proposals, keys.publicKeyPem).forProposal(proposalId);
  assert.equal(status.displayStatus, "RECONCILED"); assert.equal(status.paymentKind, "GENUINE_PAYPAL_SANDBOX_PAYMENT"); assert.equal(status.steps.reconciliation, true); assert.equal(status.receipt.paymentStatus, "Completed — independently verified capture"); assert.equal(status.receipt.reconciliation, "RECONCILED");
  assert.equal(status.receipt.paypalOrderId, "ORDER-STATUS-001"); assert.equal(status.receipt.paypalMerchantId, "merchant-status"); assert.equal(status.receipt.paypalCaptureId, "CAP-STATUS-001"); assert.equal(status.receipt.captureReference, "CAP-STATUS-001");
});

test("synthetic evidence remains visibly synthetic and a non-success state cannot render reconciled", async (t) => {
  const { ledger, proposals, workflow, keys, proposalId } = await fixture(t); await workflow.runSyntheticDemo(proposalId);
  const synthetic = await new TransactionStatusService(ledger, proposals, keys.publicKeyPem).forProposal(proposalId);
  assert.equal(synthetic.paymentKind, "SYNTHETIC_DEMO_PAYMENT"); assert.equal(synthetic.receipt.paymentProvider, "Synthetic demo"); assert.notEqual(synthetic.receipt.paymentStatus, "Completed — independently verified capture");
  const pending = await fixture(t); const status = await new TransactionStatusService(pending.ledger, pending.proposals, pending.keys.publicKeyPem).forProposal(pending.proposalId);
  assert.notEqual(status.displayStatus, "RECONCILED"); assert.equal(status.ledgerState, "SIGNED");
});

test("a valid generated proposal projects completed financial validation before a ledger instruction exists", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".transaction-status-proposal-only-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519"); const keys = { privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "proposal-only-status" };
  const ledger = new LocalDurableLedger(join(root, "ledger.json")); const proposals = new LocalProposalStore(join(root, "proposals.json")); const workflow = new DemoWorkflowService(ledger, proposals, new SyntheticInstructionDraftingAgent(), keys);
  const generated = await workflow.generate(source);
  const status = await new TransactionStatusService(ledger, proposals, keys.publicKeyPem).forProposal(generated.proposal.proposalId);
  assert.equal(generated.status, "PENDING_HUMAN_APPROVAL"); assert.deepEqual(generated.validationErrors, []);
  assert.equal(status.displayStatus, "PENDING_HUMAN_APPROVAL"); assert.equal(status.ledgerState, "NO_LEDGER_RECORD"); assert.equal(status.steps.validated, true); assert.equal(status.steps.humanApproval, false); assert.equal(status.steps.signature, false);
});
