import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { DemoWorkflowService, LocalDurableLedger, LocalProposalStore, OllamaInstructionDraftingAgent, SyntheticInstructionDraftingAgent, classifyRequirementLabels, loadOllamaConfig, validateProposal } from "../src/index.js";

const config = { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b", timeoutMs: 1_000 };
const completeInstruction = "Prepare a fictional demonstration instruction to collect GBP 100 through PayPal for payment purpose: family housing support. Following verified payment and explicit human approval, simulate a Philippines payout to beneficiary reference: PH-DEMO-001. Do not execute an actual transfer.";
const validDraft = { purpose: "PHILIPPINES_CONDITIONAL_PAYOUT", collectionAmount: "100", collectionCurrency: "GBP", beneficiaryReference: "PH-DEMO-001", beneficiaryCountry: "PH", paymentPurpose: "family housing support", missingInformation: [], unsupportedAssumptions: [], explanation: "Draft only; all authority remains deterministic." };

test("Ollama adapter requests local schema-constrained chat and records local provenance", async () => {
  const agent = new OllamaInstructionDraftingAgent(config, async (url, init) => {
    assert.equal(url, "http://127.0.0.1:11434/api/chat"); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    const request = JSON.parse(String(init.body)); assert.equal(request.model, "qwen2.5-coder:7b"); assert.equal(request.stream, false); assert.equal(request.format.type, "object");
    assert.match(request.messages[0].content, /operator-selected transaction type is PHILIPPINES_CONDITIONAL_PAYOUT/i);
    assert.match(request.messages[1].content, /Operator-selected transaction type \(authoritative\): PHILIPPINES_CONDITIONAL_PAYOUT/);
    return { ok: true, status: 200, json: async () => ({ model: "qwen2.5-coder:7b", message: { content: JSON.stringify(validDraft) } }) };
  });
  const proposal = await agent.draft({ instruction: completeInstruction });
  assert.equal(proposal.provenance, "AI_GENERATED"); assert.equal(proposal.generation?.provider, "OLLAMA_LOCAL"); assert.equal(proposal.generation?.model, "qwen2.5-coder:7b"); assert.equal(validateProposal(proposal).valid, true);
  assert.deepEqual(proposal.fieldProvenance, { collectionAmount: "SOURCE_TEXT", collectionCurrency: "SOURCE_TEXT", beneficiaryReference: "SOURCE_TEXT", beneficiaryCountry: "SOURCE_TEXT", paymentPurpose: "SOURCE_TEXT" });
});

test("Ollama adapter rejects remote endpoints, malformed output, timeout, and invented beneficiary facts", async () => {
  assert.throws(() => loadOllamaConfig({ HBIEPA_AI_PROVIDER: "ollama", HBIEPA_OLLAMA_BASE_URL: "https://models.example.test" }), /LOOPBACK/);
  assert.throws(() => loadOllamaConfig({ HBIEPA_AI_PROVIDER: "ollama", HBIEPA_OLLAMA_BASE_URL: "http://127.0.0.1:11434/api/chat" }), /LOOPBACK/);
  const malformed = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: "{bad" } }) }));
  await assert.rejects(() => malformed.draft({ instruction: completeInstruction }), /OLLAMA_RESPONSE_NOT_JSON/);
  const timeout = new OllamaInstructionDraftingAgent(config, async (_url, init) => new Promise((_, reject) => (init.signal as AbortSignal).addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })) )));
  await assert.rejects(() => timeout.draft({ instruction: completeInstruction }), /OLLAMA_REQUEST_TIMEOUT/);
  const invented = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ ...validDraft, beneficiaryReference: "INVENTED-999" }) } }) }));
  const proposal = await invented.draft({ instruction: "Prepare an instruction to collect GBP 100 through PayPal for payment purpose: family housing support. Simulate a Philippines payout after verified payment and human approval." });
  assert.equal(validateProposal(proposal).valid, false); assert.ok(proposal.unsupportedAssumptions.includes("UNSUPPORTED_AI_BENEFICIARY"));
});

test("explicit source financial fields survive incomplete model echoes while lifecycle dependencies remain deferred", async () => {
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ ...validDraft, collectionAmount: "", beneficiaryReference: "", paymentPurpose: "", missingInformation: ["payment evidence", "explicit human approval"], unsupportedAssumptions: ["funding", "execution"] }) } }) }));
  const proposal = await agent.draft({ instruction: completeInstruction });
  assert.equal(proposal.collection.amount, "100"); assert.equal(proposal.collection.currency, "GBP"); assert.equal(proposal.beneficiary.reference, "PH-DEMO-001");
  assert.equal(validateProposal(proposal).valid, true); assert.deepEqual(proposal.deferredRequirements, ["payment evidence", "explicit human approval", "funding", "execution"]);
  assert.ok(proposal.generation?.normalisations?.includes("SOURCE_COLLECTION_AMOUNT_OVERRULED_MODEL_DRAFT"));
});

test("incomplete source instructions remain blocked even when the model supplies plausible financial facts", async () => {
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(validDraft) } }) }));
  const proposal = await agent.draft({ instruction: "Prepare an instruction to collect GBP 100 through PayPal after verified payment and human approval." });
  const validation = validateProposal(proposal);
  assert.equal(validation.valid, false); assert.ok(validation.errors.includes("MISSING_INFORMATION:beneficiary_reference"));
});

test("operator approval is deferred from proposal validation and remains digest-bound", async (t) => {
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ ...validDraft, missingInformation: ["Operator Approval"], unsupportedAssumptions: [] }) } }) }));
  const proposal = await agent.draft({ instruction: completeInstruction });
  assert.equal(validateProposal(proposal).valid, true); assert.deepEqual(proposal.deferredRequirements, ["Operator Approval"]);
  const directory = await mkdtemp(join(process.cwd(), ".stage3a-approval-test-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalProposalStore(join(directory, "proposals.json")); const pending = await store.create(proposal);
  assert.equal(pending.status, "PENDING_HUMAN_APPROVAL"); assert.equal(pending.approval, undefined);
  const approved = await store.approve(proposal.proposalId, "test-operator");
  assert.equal(approved.status, "APPROVED"); assert.equal(approved.approval?.proposalDigest, pending.digest); assert.equal(approved.approval?.operatorId, "test-operator");
});

test("canonical requirement classification accepts human-readable and camelCase labels without letting them decide readiness", () => {
  const classified = classifyRequirementLabels(["Human Approval", "operatorApproval", "paymentEvidence", "permissions", "collectionAmount", "unrecognised note"]);
  assert.deepEqual(classified.deferredWorkflowRequirements, ["Human Approval", "operatorApproval", "paymentEvidence"]);
  assert.deepEqual(classified.unresolvedPrerequisites, ["permissions"]);
  assert.deepEqual(classified.missingInstructionFields, ["collectionAmount"]);
  assert.deepEqual(classified.diagnostics, ["unrecognised note"]);
});

test("Ollama donation diagnostics do not override a complete source-backed recipient", async () => {
  const donationDraft = { ...validDraft, purpose: "INSTITUTIONAL_DONATION", beneficiaryReference: "", beneficiaryCountry: "GB", missingInformation: ["paymentEvidence", "permissions"], unsupportedAssumptions: [] };
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(donationDraft) } }) }));
  const proposal = await agent.draft({ instruction: "Prepare an institutional donation instruction to collect GBP 20 through PayPal for payment purpose: community housing support. Recipient reference: INST-DEMO-020." });
  assert.equal(proposal.downstreamAction, "RECORD_DONATION_ELIGIBILITY"); assert.equal(proposal.beneficiary.reference, "INST-DEMO-020"); assert.equal(validateProposal(proposal).valid, true);
  assert.deepEqual(proposal.deferredRequirements, ["paymentEvidence"]); assert.deepEqual(proposal.unresolvedPrerequisites, ["permissions"]);
});

test("Ollama cannot change an explicit payout selection into a donation or reach approval", async (t) => {
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ ...validDraft, purpose: "INSTITUTIONAL_DONATION" }) } }) }));
  const proposal = await agent.draft({ instruction: completeInstruction });
  assert.equal(proposal.purpose, "PHILIPPINES_CONDITIONAL_PAYOUT");
  assert.ok(proposal.unsupportedAssumptions.includes("UNSUPPORTED_AI_TRANSACTION_TYPE"));
  assert.equal(validateProposal(proposal).valid, false);
  const directory = await mkdtemp(join(process.cwd(), ".stage3a-mismatch-test-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalProposalStore(join(directory, "proposals.json")); const stored = await store.create(proposal);
  assert.equal(stored.status, "NEEDS_CLARIFICATION");
  await assert.rejects(() => store.approve(proposal.proposalId, "test-operator"), /not pending valid human approval/);
});

test("Ollama cannot change an explicit donation selection into a payout", async () => {
  const donationInstruction = "Prepare an institutional donation instruction to collect GBP 20 through PayPal Sandbox for payment purpose: community housing support. Fictional institutional recipient display name: HomeBound Community Trust. Recipient reference: INST-DEMO-020. Record donation eligibility only; do not execute a payment, settlement, or payout.";
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(validDraft) } }) }));
  const proposal = await agent.draft({ instruction: donationInstruction });
  assert.equal(proposal.purpose, "INSTITUTIONAL_DONATION");
  assert.equal(proposal.beneficiary.reference, "INST-DEMO-020");
  assert.ok(proposal.unsupportedAssumptions.includes("UNSUPPORTED_AI_TRANSACTION_TYPE"));
  assert.equal(validateProposal(proposal).valid, false);
});

test("a consistently classified Ollama proposal proceeds through existing approval and signing", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".stage3a-signed-test-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const keys = { privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "stage3a-test-key" };
  const agent = new OllamaInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(validDraft) } }) }));
  const service = new DemoWorkflowService(new LocalDurableLedger(join(directory, "ledger.json")), new LocalProposalStore(join(directory, "proposals.json")), agent, keys);
  const generated = await service.generate(completeInstruction);
  assert.equal(generated.status, "PENDING_HUMAN_APPROVAL");
  await service.approve(generated.proposal.proposalId, "test-operator");
  const signed = await service.sign(generated.proposal.proposalId);
  assert.equal(signed.signature.algorithm, "Ed25519");
});

test("action-specific deterministic requirements keep incomplete proposals blocked and complete fixtures ready", async () => {
  const agent = new SyntheticInstructionDraftingAgent();
  const incompletePayout = await agent.draft({ instruction: "Collect GBP 20 through PayPal for a Philippine payout." });
  assert.equal(validateProposal(incompletePayout).valid, false);
  const completePayout = await agent.draft({ instruction: "Collect GBP 20 through PayPal for Philippine beneficiary reference: PH-DEMO-020." });
  assert.equal(validateProposal(completePayout).valid, true);
  const missingDonationRecipient = await agent.draft({ instruction: "Collect GBP 20 through PayPal as an institutional donation." });
  assert.equal(validateProposal(missingDonationRecipient).valid, false); assert.ok(validateProposal(missingDonationRecipient).errors.includes("INSTITUTIONAL_RECIPIENT_REQUIRED"));
  const completeDonation = await agent.draft({ instruction: "Collect GBP 20 through PayPal as an institutional donation for recipient reference: INST-DEMO-001." });
  assert.equal(validateProposal(completeDonation).valid, true);
  const weakenedPayout = { ...completePayout, executionRestrictions: ["SIMULATION_ONLY"] };
  assert.equal(validateProposal(weakenedPayout).valid, false); assert.ok(validateProposal(weakenedPayout).errors.includes("SIMULATION_EXECUTION_RESTRICTIONS_REQUIRED"));
});
