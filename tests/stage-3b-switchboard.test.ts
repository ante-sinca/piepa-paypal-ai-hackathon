import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { buildSwitchboardInstruction, DemoWorkflowService, historicalEvidence, LocalDurableLedger, LocalProposalStore, recoveredInstructionInventory, renderedPage, SyntheticInstructionDraftingAgent } from "../src/index.js";

const form = { transactionType: "payout", amount: "100.00", recipientName: "Ana Santos", recipientReference: "PH-DEMO-001", destinationType: "MOCK", purpose: "family housing support", mode: "synthetic" };

async function workflow(t: test.TestContext) {
  const directory = await mkdtemp(join(process.cwd(), ".stage3b-switchboard-"));
  const pair = generateKeyPairSync("ed25519");
  const keys = { privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "stage3b-test-key" };
  const service = new DemoWorkflowService(new LocalDurableLedger(join(directory, "ledger.json")), new LocalProposalStore(join(directory, "proposals.json")), new SyntheticInstructionDraftingAgent(), keys);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return service;
}

test("Stage 3B form preserves operator financial fields and reaches the existing approval/signing/mock lifecycle", async (t) => {
  const source = buildSwitchboardInstruction(form);
  assert.match(source, /GBP 100.00/); assert.match(source, /beneficiary reference: PH-DEMO-001/);
  const service = await workflow(t); const generated = await service.generate(source);
  assert.equal(generated.status, "PENDING_HUMAN_APPROVAL");
  assert.equal(generated.proposal.collection.amount, "100.00"); assert.equal(generated.proposal.collection.currency, "GBP"); assert.equal(generated.proposal.beneficiary.reference, "PH-DEMO-001");
  await assert.rejects(() => service.sign(generated.proposal.proposalId), /Human approval/);
  await service.approve(generated.proposal.proposalId, "demo-operator");
  const signed = await service.sign(generated.proposal.proposalId); assert.equal(signed.signature.algorithm, "Ed25519");
  const completed = await service.runSyntheticDemo(generated.proposal.proposalId); assert.equal(completed.payment.evidence.isSynthetic, true); assert.equal(completed.reconciliation.status, "RECONCILED");
  await assert.rejects(() => service.runSyntheticDemo(generated.proposal.proposalId));
});

test("Stage 3B form validates recipients and makes institutional donation proposal-only", () => {
  assert.throws(() => buildSwitchboardInstruction({ ...form, recipientReference: "" }), /FICTIONAL_RECIPIENT_REFERENCE_REQUIRED/);
  const donation = buildSwitchboardInstruction({ ...form, transactionType: "donation", amount: "20.00", recipientName: "HomeBound Community Trust", recipientReference: "INST-DEMO-020", destinationType: "", purpose: "community housing support" });
  assert.match(donation, /institutional donation/i); assert.match(donation, /Record donation eligibility only/);
  assert.throws(() => buildSwitchboardInstruction({ ...form, transactionType: "donation", recipientReference: "PH-DEMO-001" }), /NEEDS_CLARIFICATION: institutional recipient is unavailable/);
  assert.throws(() => buildSwitchboardInstruction({ ...form, transactionType: "donation", recipientReference: "UNKNOWN-INSTITUTION" }), /NEEDS_CLARIFICATION: institutional recipient is unavailable/);
  assert.throws(() => buildSwitchboardInstruction({ ...form, purpose: " " }), /PAYMENT_PURPOSE_REQUIRED_OR_TOO_LARGE/);
  assert.throws(() => buildSwitchboardInstruction({ ...form, transactionType: "payout", destinationType: "BANK_ACCOUNT" }), /SUPPORTED_SYNTHETIC_DESTINATION_REQUIRED/);
});

test("Stage 3B rendered page fixes the renderer scope error, clears stale state, and loads local evidence read-only", async () => {
  const page = renderedPage();
  assert.match(page, /const p=current\.proposal,s=current\.status/);
  assert.match(page, /Previous draft, recipient details, approval and execution state were cleared/);
  assert.match(page, /The local AI interpreted the transaction type differently\. Your form fields were kept; retry generation/);
  assert.match(page, /current=signature=runResult=undefined;reviewActions\.innerHTML='';lifecycle\(\);generateButton\.disabled=true/);
  assert.match(page, /PAYPAL COLLECTION/);
  assert.match(page, /PAYPAL ORDERS V2 PAY-BY-LINK/);
  assert.match(page, /GENERATE PAYMENT LINK/);
  assert.match(page, /AUTHORISE SIMULATION/);
  assert.match(page, /correlationStatus/);
  assert.match(page, /RUN SYNTHETIC DEMO/);
  const history = await historicalEvidence({ snapshot: async () => ({ paymentEvidence: [] }) } as never);
  assert.equal(history.classification, "READ_ONLY_HISTORICAL_PAYPAL_SANDBOX_EVIDENCE");
  assert.match(history.facts[0], /No local payment-evidence records/);
});

test("switchboard includes the read-only authoritative-status refresh and safe manual return wording", () => {
  const page = renderedPage();
  assert.match(page, /transaction-status/);
  assert.match(renderedPage(), /browser return is never payment evidence/i);
});

test("PIEPA judge-facing shell presents the compact authorised workflow responsively", () => {
  const page = renderedPage();
  assert.match(page, /<title>PIEPA — Payment Instruction Envelope Protocol Agent<\/title>/);
  assert.match(page, /<h1>PIEPA — Payment Instruction Envelope Protocol Agent<\/h1>/);
  assert.match(page, /DEMONSTRATION ONLY — NO ACTUAL PAYMENT OR PAYOUT.*Complete the switchboard and generate a draft/);
  assert.doesNotMatch(page, /<h2>Proposal review<\/h2>/i);
  assert.match(page, /<h2>Review &amp; Authorisation<\/h2>/);
  assert.match(page, /class="currency-amount"/);
  assert.match(page, /grid-template-columns:3fr 7fr/);
  assert.match(page, /class="transaction-summary"/);
  assert.match(page, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(page, /@media\(max-width:760px\).*transaction-summary.*grid-template-columns:1fr/);
  assert.match(page, /<b>Required verification:<\/b>/);
  assert.match(page, /<b>Restrictions:<\/b>/);
});

test("judge-facing cards follow the transaction lifecycle before supporting tools", () => {
  const page = renderedPage();
  const positions = [
    '<h2>Instruction switchboard</h2>',
    '<h2>Review &amp; Authorisation</h2>',
    '<div class="transaction-summary">',
    '<h2>PayPal Sandbox preflight</h2>',
    '<h2>Recovered instructions</h2>',
    '<summary>Advanced — Technical Details &amp; Audit Evidence</summary>',
  ].map((marker) => page.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(page, /class="transaction-summary".*Transaction progress.*Transaction receipt/s);
  assert.match(page, /@media\(max-width:760px\).*transaction-summary.*grid-template-columns:1fr/);
});

test("recovery uses the explicit instruction reference and restores only read-only receipt evidence", () => {
  const page = renderedPage();
  assert.match(page, /option value="'\+escAttribute\(item\.instructionReference\)/);
  assert.match(page, /filter\(item=>item\.instructionReference===reference\)/);
  assert.match(page, /matches\.length!==1/);
  assert.match(page, /select\.value=candidate\.instructionReference/);
  assert.match(page, /addEventListener\('change'/);
  assert.match(page, /ledgerState==='RECONCILED'/);
  assert.match(page, /Verified PayPal Order ID/);
  assert.match(page, /Verified PayPal Merchant ID/);
  assert.match(page, /Verified PayPal Capture ID/);
  assert.match(page, /Mock execution reference/);
  assert.match(page, /copy-control/);
  assert.match(page, /Recovered persisted instruction read-only/);
  const recovery = page.match(/function recoverSelectedInstruction\(\).*?(?=async function loadMostRecentPersistedTransaction)/s)?.[0] ?? "";
  assert.doesNotMatch(recovery, /orders-payment-session|method:'POST'/);
});

test("recovery presentation distinguishes an unavailable historical-evidence read from a successful read", () => {
  const page = renderedPage();
  assert.match(page, /Selecting PayPal Sandbox does not make a request/);
  assert.match(page, /Historical PayPal Sandbox evidence is unavailable in this browser session/);
  assert.match(page, /Select one valid persisted instruction to recover/);
});

test("Orders pay-link UI reports progress, recovery, failures, and does not treat checkout as payment evidence", () => {
  const page = renderedPage();
  assert.match(page, /Creating PayPal Sandbox Order…/);
  assert.match(page, /Payment link ready\./);
  assert.match(page, /Payment link generation failed:/);
  assert.match(page, /Payment link generation outcome requires verification/);
  assert.match(page, /ordersPaymentAction/);
  assert.match(page, /RECOVERED_READY/);
  assert.match(page, /browser return is never payment evidence/i);
  assert.match(page, /function recoverOrdersPaymentSession/);
  assert.match(page, /PAYPAL CHECKOUT AWAITING BUYER APPROVAL/);
  assert.match(page, /OPEN EXISTING PAYPAL CHECKOUT/);
  assert.match(page, /CHECK PAYMENT STATUS/);
  assert.match(page, /PAYPAL CHECKOUT APPROVED — PAYMENT VERIFICATION REQUIRED/);
  assert.match(page, /PAYMENT_COMPLETED/);
  assert.match(page, /PAYPAL SANDBOX CHECKOUT UNAVAILABLE/);
  assert.match(page, /PAYPAL SANDBOX STATUS CHECK FAILED/);
  assert.match(page, /PAYPAL_STATUS_CHECK_TIMEOUT/);
  assert.match(page, /async function boundedJson/);
  assert.match(page, /recoverOrdersPaymentSession\(\).*boundedJson/s);
  assert.match(page, /No replacement Order will be created/);
  assert.match(page, /Recovered instructions/);
  assert.match(page, /RECOVER SELECTED INSTRUCTION/);
  assert.match(page, /function recoverSelectedInstruction/);
  assert.match(page, /PAYPAL SANDBOX ORDER UNAVAILABLE/);
  assert.match(page, /HTTP 404 \/ RESOURCE_NOT_FOUND/);
  assert.match(page, /PayPal Order ID/);
  assert.match(page, /GENERATE NEW INSTRUCTION/);
  assert.match(page, /NO EXISTING PAYPAL CHECKOUT SESSION/);
  assert.match(page, /recovered&&!recovered\.checkoutRecoveryAvailable/);
  assert.match(page, /PAYPAL SANDBOX PREFLIGHT/);
  assert.match(page, /CHECK PAYPAL SANDBOX PREFLIGHT/);
  assert.match(page, /function checkPayPalSandboxPreflight/);
  assert.match(page, /The new Sandbox Order was independently retrieved before checkout/);
});

test("recovered instruction inventory joins bindings by envelope identity and keeps equal amounts distinct", async () => {
  const proposal = (id: string, envelopeId: string) => ({ proposal: { proposalId: id, collection: { amount: "1.00", currency: "GBP" }, envelope: { envelopeId } }, status: "SIGNED" });
  const envelope = (envelopeId: string) => ({
    envelopeId,
    state: "PAYMENT_PENDING",
    versions: [{ envelope: { payload: { paymentIntent: { acceptedAmounts: { maximum: { currency: "GBP", value: "1.00" } } } } } }],
  });
  const terminal = { ...envelope("instruction-terminal"), state: "RECONCILED" };
  const snapshot = {
    instructions: [envelope("instruction-a"), envelope("instruction-b"), envelope("instruction-missing-binding"), terminal],
    orderBindings: [{ envelopeId: "instruction-a", orderId: "ORDER-A", correlationId: "corr-a" }, { envelopeId: "instruction-b", orderId: "ORDER-B", correlationId: "corr-b" }, { envelopeId: "instruction-terminal", orderId: "ORDER-TERMINAL", correlationId: "corr-terminal" }],
    orderPaymentSessions: [{ envelopeId: "instruction-a", orderId: "ORDER-A", status: "READY", approvalUrl: "https://sandbox.example/a" }, { envelopeId: "instruction-b", orderId: "ORDER-B", status: "READY", approvalUrl: "https://sandbox.example/b" }, { envelopeId: "instruction-terminal", orderId: "ORDER-TERMINAL", status: "READY", approvalUrl: "https://sandbox.example/terminal" }],
    paymentEvidence: [],
  };
  const recovered = await recoveredInstructionInventory({ snapshot: async () => snapshot } as never, { list: async () => [proposal("proposal-a", "instruction-a"), proposal("proposal-a-duplicate", "instruction-a"), proposal("proposal-b", "instruction-b"), proposal("proposal-missing-binding", "instruction-missing-binding"), proposal("proposal-terminal", "instruction-terminal")] } as never);
  assert.equal(recovered.length, 4);
  assert.deepEqual(recovered.slice(0, 2).map((item) => ({ instruction: item.instructionReference, order: item.orderId, amount: item.amount })), [
    { instruction: "instruction-a", order: "ORDER-A", amount: { currency: "GBP", value: "1.00" } },
    { instruction: "instruction-b", order: "ORDER-B", amount: { currency: "GBP", value: "1.00" } },
  ]);
  assert.equal(recovered[0].checkoutRecoveryAvailable, true);
  assert.deepEqual(recovered.find((item) => item.instructionReference === "instruction-missing-binding"), {
    proposal: proposal("proposal-missing-binding", "instruction-missing-binding"), instructionReference: "instruction-missing-binding", proposalStatus: "SIGNED", ledgerState: "PAYMENT_PENDING", amount: { currency: "GBP", value: "1.00" }, orderId: undefined, sessionStatus: undefined, approvalUrlAvailable: false, checkoutRecoveryAvailable: false, lastVerifiedProviderStatus: undefined, lastVerifiedProviderRetrievedAt: undefined, captureEvidenceStatus: "NONE",
  });
  const terminalEntry = recovered.find((item) => item.instructionReference === "instruction-terminal");
  assert.equal(terminalEntry?.ledgerState, "RECONCILED");
  assert.equal(terminalEntry?.checkoutRecoveryAvailable, false);
});

test("all executable PIEPA inline scripts parse and retain the Orders event handler wiring", () => {
  const page = renderedPage();
  const scripts = page.split("<script>").slice(1).map((part) => part.split("</script>")[0]);
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  const executable = scripts.join("\n");
  for (const handler of ["generate", "approve", "signIt", "createOrdersPaymentSession", "recoverOrdersPaymentSession", "recoverSelectedInstruction", "checkOrdersPaymentStatus", "verifyOrdersPayment", "authoriseOrdersSimulation", "executeOrdersSimulation"]) assert.match(executable, new RegExp(`function ${handler}`));
  assert.match(executable, /onclick="createOrdersPaymentSession\(\)"/);
  assert.match(executable, /AbortController/);
  assert.ok(executable.includes("if(/\\/(sign|run|orders-payment-session"));
});

test("judge-facing Review & Authorisation exposes only the permitted proposal-state actions", () => {
  const page = renderedPage();
  assert.match(page, /current\.status==='PENDING_HUMAN_APPROVAL'.*Financial validation completed.*onclick="approve\(\)".*onclick="reject\(\)"/);
  assert.match(page, /current\.status==='APPROVED'.*SIGN INSTRUCTION/);
  assert.match(page, /current\.validationErrors\.length.*Financial validation failed/);
  assert.match(page, /current\.status==='SIGNED'.*GENERATE PAYMENT LINK/);
  assert.match(page, /\['PENDING_HUMAN_APPROVAL','APPROVED','SIGNED'\]\.includes\(currentStatus\)/);
});
