import { randomUUID } from "node:crypto";
import type { EnvelopePayload } from "../contracts/envelope.js";
import { PROPOSAL_SCHEMA_VERSION, type InstructionProposal, type ProposalPurpose } from "../proposals/contracts.js";
import { classifyRequirementLabels } from "../proposals/requirement-classifier.js";
import type { InstructionDraftingAgent } from "./contracts.js";

const MAX_INSTRUCTION_CHARS = 4_000;
const MAX_RESPONSE_CHARS = 12_000;
const manipulation = /bypass|ignore (?:policy|approval|validation)|override|without (?:approval|verification)/i;
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export type OllamaConfig = Readonly<{ baseUrl: string; model: string; timeoutMs: number }>;
export type OllamaFetchResponse = Readonly<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type OllamaFetchLike = (url: string, init: RequestInit) => Promise<OllamaFetchResponse>;

type ModelDraft = Readonly<{ purpose: ProposalPurpose; collectionAmount: string; collectionCurrency: string; beneficiaryReference: string; beneficiaryCountry: string; paymentPurpose: string; missingInformation: string[]; unsupportedAssumptions: string[]; explanation: string }>;

/** Loads only a local, HTTP loopback Ollama endpoint. Remote model services are rejected. */
export function loadOllamaConfig(environment: NodeJS.ProcessEnv = process.env): OllamaConfig | undefined {
  if (!environment.HBIEPA_AI_PROVIDER) return undefined;
  if (environment.HBIEPA_AI_PROVIDER !== "ollama") return undefined;
  const baseUrl = environment.HBIEPA_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("HBIEPA_OLLAMA_BASE_URL_INVALID"); }
  if (url.protocol !== "http:" || !localHosts.has(url.hostname) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("HBIEPA_OLLAMA_LOOPBACK_ENDPOINT_REQUIRED");
  const timeoutMs = Number(environment.HBIEPA_OLLAMA_TIMEOUT_MS ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("HBIEPA_OLLAMA_TIMEOUT_MS must be 1000-120000");
  const model = environment.HBIEPA_OLLAMA_MODEL ?? "qwen2.5-coder:7b";
  if (!/^[A-Za-z0-9._:-]{2,128}$/.test(model)) throw new Error("HBIEPA_OLLAMA_MODEL has invalid characters");
  return { baseUrl: url.origin, model, timeoutMs };
}

/** Local structured-drafting adapter. It has no tools and no access to HBIEPA authority or secrets. */
export class OllamaInstructionDraftingAgent implements InstructionDraftingAgent {
  readonly provenance = "AI_GENERATED" as const;
  private readonly fetcher: OllamaFetchLike;
  constructor(private readonly config: OllamaConfig, fetcher?: OllamaFetchLike) { this.fetcher = fetcher ?? ((url, init) => fetch(url, init) as Promise<OllamaFetchResponse>); }

  async draft(input: Readonly<{ instruction: string; now?: Date }>): Promise<InstructionProposal> {
    if (!input.instruction.trim() || input.instruction.length > MAX_INSTRUCTION_CHARS) throw new Error("Instruction must contain 1-4000 characters");
    const selectedPurpose = transactionPurposeFromSource(input.instruction);
    const requestedAt = new Date(); const began = Date.now(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: OllamaFetchResponse;
    try {
      response = await this.fetcher(`${this.config.baseUrl}/api/chat`, { method: "POST", signal: controller.signal, redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: this.config.model, stream: false, format: MODEL_SCHEMA, messages: [{ role: "system", content: `${SYSTEM_INSTRUCTION} The operator-selected transaction type is ${selectedPurpose}; it is authoritative. Return that exact value in purpose and do not reclassify it.` }, { role: "user", content: `${input.instruction}\n\nOperator-selected transaction type (authoritative): ${selectedPurpose}.` }] }) });
    } catch (error: unknown) {
      if ((error as { name?: string }).name === "AbortError") throw new Error("OLLAMA_REQUEST_TIMEOUT");
      throw new Error("OLLAMA_UNAVAILABLE");
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`OLLAMA_HTTP_${response.status}`);
    const body = await response.json(); const output = outputText(body);
    if (output.length > MAX_RESPONSE_CHARS) throw new Error("OLLAMA_RESPONSE_TOO_LARGE");
    let candidate: unknown; try { candidate = JSON.parse(output); } catch { throw new Error("OLLAMA_RESPONSE_NOT_JSON"); }
    const proposal = proposalFromModelDraft(input.instruction, parseModelDraft(candidate), input.now ?? requestedAt, selectedPurpose);
    return { ...proposal, generation: { provider: "OLLAMA_LOCAL", model: this.config.model, requestedAt: requestedAt.toISOString(), durationMs: Date.now() - began, responseValid: true, ...(proposal.generation?.normalisations ? { normalisations: proposal.generation.normalisations } : {}) } };
  }
}

function outputText(value: unknown): string {
  const content = (value as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string") throw new Error("OLLAMA_RESPONSE_MISSING_OUTPUT");
  return content;
}
function parseModelDraft(value: unknown): ModelDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OLLAMA_RESPONSE_SCHEMA_INVALID");
  const record = value as Record<string, unknown>; const keys = ["purpose", "collectionAmount", "collectionCurrency", "beneficiaryReference", "beneficiaryCountry", "paymentPurpose", "missingInformation", "unsupportedAssumptions", "explanation"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) throw new Error("OLLAMA_RESPONSE_SCHEMA_INVALID");
  if ((record.purpose !== "PHILIPPINES_CONDITIONAL_PAYOUT" && record.purpose !== "INSTITUTIONAL_DONATION") || ["collectionAmount", "collectionCurrency", "beneficiaryReference", "beneficiaryCountry", "paymentPurpose", "explanation"].some((key) => typeof record[key] !== "string") || !strings(record.missingInformation) || !strings(record.unsupportedAssumptions)) throw new Error("OLLAMA_RESPONSE_SCHEMA_INVALID");
  return record as unknown as ModelDraft;
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 160);

/* The model's fields are drafts. Envelope expiry and all authority controls are deterministic application values. */
function transactionPurposeFromSource(sourceText: string): ProposalPurpose {
  return /\binstitutional donation\b/i.test(sourceText) ? "INSTITUTIONAL_DONATION" : "PHILIPPINES_CONDITIONAL_PAYOUT";
}

function proposalFromModelDraft(sourceText: string, draft: ModelDraft, now: Date, expectedPurpose = transactionPurposeFromSource(sourceText)): InstructionProposal {
  // Transaction type is an explicit source fact. The local model cannot switch a payout into a donation or vice versa.
  const donation = expectedPurpose === "INSTITUTIONAL_DONATION"; const findings = classifyRequirementLabels([...draft.missingInformation, ...draft.unsupportedAssumptions]); const missing: string[] = []; const unsupported: string[] = []; const normalisations: string[] = [];
  if (draft.purpose !== expectedPurpose) unsupported.push("UNSUPPORTED_AI_TRANSACTION_TYPE");
  const suppliedAmount = sourceText.match(/(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i)?.[1];
  const suppliedBeneficiary = sourceText.match(/beneficiary(?:\s+(?:reference|id))?\s*[:#]\s*([A-Za-z0-9_-](?:[A-Za-z0-9._-]{1,126}[A-Za-z0-9_-])?)/i)?.[1];
  const suppliedInstitutionRecipient = sourceText.match(/(?:institution(?:al)?\s+)?recipient(?:\s+(?:reference|id))?\s*[:#]\s*([A-Za-z0-9_-](?:[A-Za-z0-9._-]{1,126}[A-Za-z0-9_-])?)/i)?.[1];
  const suppliedPurpose = sourceText.match(/payment purpose\s*:\s*([^\r\n.]{3,160})/i)?.[1]?.trim();
  const amount = suppliedAmount ?? "";
  if (!amount) { missing.push("collection_amount"); if (draft.collectionAmount) unsupported.push("UNSUPPORTED_AI_COLLECTION_AMOUNT"); }
  else if (draft.collectionAmount !== amount) normalisations.push("SOURCE_COLLECTION_AMOUNT_OVERRULED_MODEL_DRAFT");
  const currency = /\bGBP\b/i.test(sourceText) ? "GBP" : "";
  if (!currency) { missing.push("collection_currency"); if (draft.collectionCurrency) unsupported.push("UNSUPPORTED_AI_COLLECTION_CURRENCY"); }
  else if (draft.collectionCurrency !== currency) normalisations.push("SOURCE_COLLECTION_CURRENCY_OVERRULED_MODEL_DRAFT");
  const beneficiary = donation ? suppliedInstitutionRecipient ?? "" : suppliedBeneficiary ?? "";
  if (!beneficiary) { missing.push(donation ? "institutional_recipient" : "beneficiary_reference"); if (draft.beneficiaryReference) unsupported.push(donation ? "UNSUPPORTED_AI_INSTITUTIONAL_RECIPIENT" : "UNSUPPORTED_AI_BENEFICIARY"); }
  else if (draft.beneficiaryReference !== beneficiary) normalisations.push(donation ? "SOURCE_INSTITUTIONAL_RECIPIENT_OVERRULED_MODEL_DRAFT" : "SOURCE_BENEFICIARY_REFERENCE_OVERRULED_MODEL_DRAFT");
  if (!donation && !/philippine|philippines/i.test(sourceText)) missing.push("beneficiary_country");
  else if (!donation && draft.beneficiaryCountry !== "PH") normalisations.push("SOURCE_BENEFICIARY_COUNTRY_OVERRULED_MODEL_DRAFT");
  if (manipulation.test(sourceText)) unsupported.push("AI_POLICY_MANIPULATION_ATTEMPT");
  const paymentPurpose = suppliedPurpose ?? draft.paymentPurpose;
  if (!paymentPurpose) missing.push("payment_purpose"); else if (suppliedPurpose && draft.paymentPurpose !== suppliedPurpose) normalisations.push("SOURCE_PAYMENT_PURPOSE_OVERRULED_MODEL_DRAFT");
  const value = amount || "1.00"; const payoutBeneficiary = donation ? "institution-designation-pending" : beneficiary || "beneficiary-pending"; const envelopeId = `ollama-${randomUUID()}`;
  const envelope: EnvelopePayload = { envelopeId, version: "1.0", issuerId: "hbiepa-demo-operator", authorisedPartyId: "hbiepa-demo-operator", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), nonce: randomUUID(), paymentIntent: { collectionPurpose: paymentPurpose || "purpose-pending", acceptedAmounts: { minimum: { currency: currency || "GBP", value }, maximum: { currency: currency || "GBP", value } }, permittedPaymentProviders: ["paypal-sandbox"] }, beneficiary: { beneficiaryReference: payoutBeneficiary, destinationType: "MOCK", destinationReference: donation ? "proposal-only" : "simulated-philippines-destination", destinationCountry: donation ? "GB" : "PH" }, permittedActions: donation ? ["COLLECT_PAYMENT", "VERIFY_PAYMENT"] : ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"], requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "HUMAN_APPROVAL_RECORDED"], authorisationPolicyRef: donation ? "stage2b-donation-proposal-only" : "stage3a-synthetic-demo-policy", execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency: currency || "GBP", value }, oneTimeAuthorisationRequired: true }, auditReference: `audit-${envelopeId}`, reconciliationReference: `reconcile-${envelopeId}` };
  return { proposalId: `proposal-${randomUUID()}`, version: 1, schemaVersion: PROPOSAL_SCHEMA_VERSION, createdAt: now.toISOString(), sourceText, provenance: "AI_GENERATED", purpose: expectedPurpose, collection: { provider: "paypal-sandbox", ...(amount ? { amount, currency } : {}) }, paymentPurpose: envelope.paymentIntent.collectionPurpose, beneficiary: beneficiary ? { reference: beneficiary, country: donation ? "GB" : "PH", destinationType: "MOCK" } : {}, downstreamAction: donation ? "RECORD_DONATION_ELIGIBILITY" : "AUTHORISE_SIMULATED_PAYOUT", requiredVerification: envelope.requiredVerification, authorisationRequirements: ["EXPLICIT_HUMAN_APPROVAL", "SIGNED_ENVELOPE", "DETERMINISTIC_POLICY_ALLOW"], executionRestrictions: ["SIMULATION_ONLY", "SINGLE_USE_AUTHORISATION", "NO_EXTERNAL_PAYOUT"], missingInformation: [...new Set(missing)], unsupportedAssumptions: [...new Set(unsupported)], fieldProvenance: { collectionAmount: amount ? "SOURCE_TEXT" : "MISSING", collectionCurrency: currency ? "SOURCE_TEXT" : "MISSING", beneficiaryReference: beneficiary ? "SOURCE_TEXT" : "MISSING", beneficiaryCountry: donation || /philippine|philippines/i.test(sourceText) ? "SOURCE_TEXT" : "MISSING", paymentPurpose: suppliedPurpose ? "SOURCE_TEXT" : paymentPurpose ? "MODEL_DRAFT" : "MISSING" }, ...(findings.deferredWorkflowRequirements.length ? { deferredRequirements: findings.deferredWorkflowRequirements } : {}), ...(findings.unresolvedPrerequisites.length ? { unresolvedPrerequisites: findings.unresolvedPrerequisites } : {}), ...(findings.missingInstructionFields.length || findings.diagnostics.length ? { modelRequirementDiagnostics: [...findings.missingInstructionFields, ...findings.diagnostics] } : {}), ...(normalisations.length ? { generation: { provider: "OLLAMA_LOCAL", model: "", requestedAt: "", durationMs: 0, responseValid: true, normalisations } } : {}), envelope };
}

const SYSTEM_INSTRUCTION = "You draft an HBIEPA proposal only. Return JSON matching the schema. You have no authority to approve, sign, verify payment, authorise, or execute. Do not invent beneficiary data, payment purpose, exchange rates, payout amounts, permissions, funding, payment evidence, or deadlines. Put absent or unsupported information in the respective arrays.";
const MODEL_SCHEMA = { type: "object", additionalProperties: false, required: ["purpose", "collectionAmount", "collectionCurrency", "beneficiaryReference", "beneficiaryCountry", "paymentPurpose", "missingInformation", "unsupportedAssumptions", "explanation"], properties: { purpose: { type: "string", enum: ["PHILIPPINES_CONDITIONAL_PAYOUT", "INSTITUTIONAL_DONATION"] }, collectionAmount: { type: "string" }, collectionCurrency: { type: "string" }, beneficiaryReference: { type: "string" }, beneficiaryCountry: { type: "string" }, paymentPurpose: { type: "string" }, missingInformation: { type: "array", items: { type: "string" } }, unsupportedAssumptions: { type: "array", items: { type: "string" } }, explanation: { type: "string" } } };
