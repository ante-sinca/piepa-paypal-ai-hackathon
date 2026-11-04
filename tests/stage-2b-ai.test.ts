import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAIInstructionDraftingAgent, listenLoopbackDemo, loadOpenAIConfig, validateProposal } from "../src/index.js";

const config = { apiKey: "test-key-not-a-secret", model: "gpt-4o-mini", timeoutMs: 1_000 };
const instruction = "Collect GBP 100 through PayPal for Philippine beneficiary reference: PH-DEMO-001 after verification and approval.";
const validDraft = { purpose: "PHILIPPINES_CONDITIONAL_PAYOUT", collectionAmount: "100", collectionCurrency: "GBP", beneficiaryReference: "PH-DEMO-001", beneficiaryCountry: "PH", paymentPurpose: "conditional payout", missingInformation: [], unsupportedAssumptions: [], explanation: "Draft only; human approval remains required." };

test("OpenAI adapter validates a structured model response independently", async () => {
  const agent = new OpenAIInstructionDraftingAgent(config, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(init.method, "POST");
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(validDraft) }), text: async () => "" };
  });
  const proposal = await agent.draft({ instruction });
  assert.equal(proposal.provenance, "AI_GENERATED");
  assert.equal(validateProposal(proposal).valid, true);
});

test("OpenAI adapter fails closed for configuration, malformed output, and timeout", async () => {
  assert.throws(() => loadOpenAIConfig({ HBIEPA_AI_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  const malformed = new OpenAIInstructionDraftingAgent(config, async () => ({ ok: true, status: 200, json: async () => ({ output_text: '{"unexpected":true}' }), text: async () => "" }));
  await assert.rejects(() => malformed.draft({ instruction }), /AI_RESPONSE_SCHEMA_INVALID/);
  const timedOut = new OpenAIInstructionDraftingAgent(config, async (_url, init) => new Promise((_, reject) => (init.signal as AbortSignal).addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })) )));
  await assert.rejects(() => timedOut.draft({ instruction }), /AI_REQUEST_TIMEOUT/);
});

test("loopback demo listener reports occupied ports without terminating the owner", async (t) => {
  const owner = createServer(); await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve)); t.after(() => owner.close());
  const address = owner.address(); if (!address || typeof address === "string") throw new Error("Test listener did not receive a port");
  const candidate = createServer(); t.after(() => candidate.close());
  await assert.rejects(() => listenLoopbackDemo(candidate, address.port), /DEMO_PORT_IN_USE/);
});
