import { randomUUID } from "node:crypto";
import type { EnvelopePayload } from "../contracts/envelope.js";
import type { InstructionProposal, ProposalPurpose } from "../proposals/contracts.js";
import { PROPOSAL_SCHEMA_VERSION } from "../proposals/contracts.js";
import type { InstructionDraftingAgent } from "./contracts.js";

const MAX_INSTRUCTION_CHARS = 4_000;
const MAX_RESPONSE_CHARS = 12_000;
const manipulation = /bypass|ignore (?:policy|approval|validation)|override|without (?:approval|verification)/i;

export type OpenAIConfig = Readonly<{ apiKey: string; model: string; timeoutMs: number }>;
export type OpenAIFetchResponse = Readonly<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
export type OpenAIFetchLike = (url: string, init: RequestInit) => Promise<OpenAIFetchResponse>;

type ModelDraft = Readonly<{
  purpose: ProposalPurpose;
  collectionAmount: string;
  collectionCurrency: string;
  beneficiaryReference: string;
  beneficiaryCountry: string;
  paymentPurpose: string;
  missingInformation: string[];
  unsupportedAssumptions: string[];
  explanation: string;
}>;

export function loadOpenAIConfig(environment: NodeJS.ProcessEnv = process.env): OpenAIConfig | undefined {
  if (!environment.HBIEPA_AI_PROVIDER) return undefined;
  if (environment.HBIEPA_AI_PROVIDER !== "openai") throw new Error("Unsupported HBIEPA_AI_PROVIDER; only openai is configured");
  if (!environment.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for Genuine AI mode");
  const timeoutMs = Number(environment.HBIEPA_AI_REQUEST_TIMEOUT_MS ?? "15000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new Error("HBIEPA_AI_REQUEST_TIMEOUT_MS must be 1000-30000");
  const model = environment.HBIEPA_AI_MODEL ?? "gpt-4o-mini";
  if (!/^[A-Za-z0-9._-]{2,128}$/.test(model)) throw new Error("HBIEPA_AI_MODEL has invalid characters");
  return { apiKey: environment.OPENAI_API_KEY, model, timeoutMs };
}

/** Server-side Responses API adapter. It has no tools, secrets other than its API key, or financial authority. */
export class OpenAIInstructionDraftingAgent implements InstructionDraftingAgent {
  readonly provenance = "AI_GENERATED" as const;
  private readonly fetcher: OpenAIFetchLike;
  constructor(private readonly config: OpenAIConfig, fetcher?: OpenAIFetchLike) { this.fetcher = fetcher ?? ((url, init) => fetch(url, init) as Promise<OpenAIFetchResponse>); }

  async draft(input: Readonly<{ instruction: string; now?: Date }>): Promise<InstructionProposal> {
    if (!input.instruction.trim() || input.instruction.length > MAX_INSTRUCTION_CHARS) throw new Error("Instruction must contain 1-4000 characters");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: OpenAIFetchResponse;
    try {
      response = await this.fetcher("https://api.openai.com/v1/responses", {
        method: "POST", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.model, store: false, input: [{ role: "developer", content: [{ type: "input_text", text: SYSTEM_INSTRUCTION }] }, { role: "user", content: [{ type: "input_text", text: input.instruction }] }], text: { format: { type: "json_schema", name: "hbiepa_instruction_proposal", strict: true, schema: MODEL_SCHEMA } } }),
      });
    } catch (error: unknown) {
      if ((error as { name?: string }).name === "AbortError") throw new Error("AI_REQUEST_TIMEOUT");
      throw new Error("AI_PROVIDER_REQUEST_FAILED");
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`AI_PROVIDER_HTTP_${response.status}`);
    const output = extractOutputText(await response.json());
    if (output.length > MAX_RESPONSE_CHARS) throw new Error("AI_RESPONSE_TOO_LARGE");
    let candidate: unknown; try { candidate = JSON.parse(output); } catch { throw new Error("AI_RESPONSE_NOT_JSON"); }
    return proposalFromModelDraft(input.instruction, parseModelDraft(candidate), input.now ?? new Date());
  }
}

function extractOutputText(value: unknown): string {
  const record = value as { output_text?: unknown; output?: unknown[] };
  if (typeof record?.output_text === "string") return record.output_text;
  const content = Array.isArray(record?.output) ? record.output.flatMap((item) => {
    const parts = (item as { content?: unknown }).content; return Array.isArray(parts) ? parts : [];
  }) : [];
  const text = content.find((part) => (part as { type?: unknown }).type === "output_text") as { text?: unknown } | undefined;
  if (typeof text?.text !== "string") throw new Error("AI_RESPONSE_MISSING_OUTPUT");
  return text.text;
}

function parseModelDraft(value: unknown): ModelDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI_RESPONSE_SCHEMA_INVALID");
  const record = value as Record<string, unknown>;
  const keys = ["purpose", "collectionAmount", "collectionCurrency", "beneficiaryReference", "beneficiaryCountry", "paymentPurpose", "missingInformation", "unsupportedAssumptions", "explanation"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) throw new Error("AI_RESPONSE_SCHEMA_INVALID");
  if ((record.purpose !== "PHILIPPINES_CONDITIONAL_PAYOUT" && record.purpose !== "INSTITUTIONAL_DONATION") || ["collectionAmount", "collectionCurrency", "beneficiaryReference", "beneficiaryCountry", "paymentPurpose", "explanation"].some((key) => typeof record[key] !== "string") || !isStringArray(record.missingInformation) || !isStringArray(record.unsupportedAssumptions)) throw new Error("AI_RESPONSE_SCHEMA_INVALID");
  return record as unknown as ModelDraft;
}
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 160);

function proposalFromModelDraft(sourceText: string, draft: ModelDraft, now: Date): InstructionProposal {
  const donation = draft.purpose === "INSTITUTIONAL_DONATION";
  const missing = [...draft.missingInformation];
  if (!draft.collectionAmount) missing.push("collection_amount");
  if (!donation && !draft.beneficiaryReference) missing.push("beneficiary_reference");
  if (!donation && draft.beneficiaryCountry !== "PH") missing.push("beneficiary_country");
  const unsupported = [...draft.unsupportedAssumptions, ...(manipulation.test(sourceText) ? ["AI_POLICY_MANIPULATION_ATTEMPT"] : [])];
  const envelopeId = `ai-${randomUUID()}`; const value = draft.collectionAmount || "1.00"; const currency = draft.collectionCurrency || "GBP";
  const beneficiaryReference = donation ? "institution-designation-pending" : draft.beneficiaryReference || "beneficiary-pending";
  const envelope: EnvelopePayload = {
    envelopeId, version: "1.0", issuerId: "hbiepa-demo-operator", authorisedPartyId: "hbiepa-demo-operator", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), nonce: randomUUID(),
    paymentIntent: { collectionPurpose: draft.paymentPurpose || (donation ? "institutional donation designation" : "conditional Philippine payout funding"), acceptedAmounts: { minimum: { currency, value }, maximum: { currency, value } }, permittedPaymentProviders: ["paypal-sandbox"] },
    beneficiary: { beneficiaryReference, destinationType: "MOCK", destinationReference: donation ? "proposal-only" : "simulated-philippines-destination", destinationCountry: donation ? "GB" : "PH" }, permittedActions: donation ? ["COLLECT_PAYMENT", "VERIFY_PAYMENT"] : ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
    requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "HUMAN_APPROVAL_RECORDED"], authorisationPolicyRef: donation ? "stage2b-donation-proposal-only" : "stage2a-synthetic-demo-policy", execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency, value }, oneTimeAuthorisationRequired: true }, auditReference: `audit-${envelopeId}`, reconciliationReference: `reconcile-${envelopeId}`,
  };
  return { proposalId: `proposal-${randomUUID()}`, version: 1, schemaVersion: PROPOSAL_SCHEMA_VERSION, createdAt: now.toISOString(), sourceText, provenance: "AI_GENERATED", purpose: draft.purpose, collection: { provider: "paypal-sandbox", ...(draft.collectionAmount ? { amount: draft.collectionAmount, currency: draft.collectionCurrency } : {}) }, paymentPurpose: envelope.paymentIntent.collectionPurpose, beneficiary: !donation && draft.beneficiaryReference && draft.beneficiaryCountry === "PH" ? { reference: draft.beneficiaryReference, country: "PH", destinationType: "MOCK" } : donation ? { country: "GB", destinationType: "MOCK" } : {}, downstreamAction: donation ? "RECORD_DONATION_ELIGIBILITY" : "AUTHORISE_SIMULATED_PAYOUT", requiredVerification: envelope.requiredVerification, authorisationRequirements: ["EXPLICIT_HUMAN_APPROVAL", "SIGNED_ENVELOPE", "DETERMINISTIC_POLICY_ALLOW"], executionRestrictions: ["SIMULATION_ONLY", "SINGLE_USE_AUTHORISATION", "NO_EXTERNAL_PAYOUT"], missingInformation: [...new Set(missing)], unsupportedAssumptions: [...new Set(unsupported)], envelope };
}

const SYSTEM_INSTRUCTION = "You draft a proposed HBIEPA payment instruction. Return JSON only. You have no authority to approve, sign, verify payment, authorize, or execute. Do not invent beneficiary details, exchange rates, permissions, funding, regulatory approval, or payment evidence. Identify missing information and unsupported assumptions.";
const MODEL_SCHEMA = { type: "object", additionalProperties: false, required: ["purpose", "collectionAmount", "collectionCurrency", "beneficiaryReference", "beneficiaryCountry", "paymentPurpose", "missingInformation", "unsupportedAssumptions", "explanation"], properties: { purpose: { type: "string", enum: ["PHILIPPINES_CONDITIONAL_PAYOUT", "INSTITUTIONAL_DONATION"] }, collectionAmount: { type: "string" }, collectionCurrency: { type: "string" }, beneficiaryReference: { type: "string" }, beneficiaryCountry: { type: "string" }, paymentPurpose: { type: "string" }, missingInformation: { type: "array", items: { type: "string" } }, unsupportedAssumptions: { type: "array", items: { type: "string" } }, explanation: { type: "string" } } };
