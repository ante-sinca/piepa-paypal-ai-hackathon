import type { EnvelopePayload } from "../contracts/envelope.js";

export const PROPOSAL_SCHEMA_VERSION = "2.0" as const;

export type AgentProvenance = "AI_GENERATED" | "SYNTHETIC_AI_DEMO" | "MANUALLY_EDITED";
export type ProposalPurpose = "PHILIPPINES_CONDITIONAL_PAYOUT" | "INSTITUTIONAL_DONATION";
export type ProposalStatus = "DRAFT" | "VALID" | "PENDING_HUMAN_APPROVAL" | "NEEDS_CLARIFICATION" | "APPROVED" | "REJECTED" | "SIGNED";

export type InstructionProposal = Readonly<{
  proposalId: string;
  version: number;
  schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  createdAt: string;
  sourceText: string;
  provenance: AgentProvenance;
  purpose: ProposalPurpose;
  collection: Readonly<{ provider: "paypal-sandbox"; amount?: string; currency?: string }>;
  paymentPurpose: string;
  beneficiary: Readonly<{ reference?: string; country?: string; destinationType?: "MOCK" | "BANK_ACCOUNT" | "E_WALLET" }>;
  downstreamAction: "AUTHORISE_SIMULATED_PAYOUT" | "RECORD_DONATION_ELIGIBILITY";
  requiredVerification: readonly string[];
  authorisationRequirements: readonly string[];
  executionRestrictions: readonly string[];
  missingInformation: readonly string[];
  unsupportedAssumptions: readonly string[];
  /** Server-observed generation provenance; never supplied by the model. */
  generation?: Readonly<{ provider: "OLLAMA_LOCAL"; model: string; requestedAt: string; durationMs: number; responseValid: boolean; normalisations?: readonly string[] }>;
  /** Financial facts accepted only from explicit instruction text, never inferred from a model draft. */
  fieldProvenance?: Readonly<{ collectionAmount: "SOURCE_TEXT" | "MISSING"; collectionCurrency: "SOURCE_TEXT" | "MISSING"; beneficiaryReference: "SOURCE_TEXT" | "MISSING"; beneficiaryCountry: "SOURCE_TEXT" | "MISSING"; paymentPurpose: "SOURCE_TEXT" | "MODEL_DRAFT" | "MISSING" }>;
  /** Requirements for later stages, not missing financial facts in the proposal itself. */
  deferredRequirements?: readonly string[];
  /** Provider or institutional prerequisites that are not financial instruction fields. */
  unresolvedPrerequisites?: readonly string[];
  /** Untrusted model labels retained as diagnostics; they do not decide readiness. */
  modelRequirementDiagnostics?: readonly string[];
  envelope: EnvelopePayload;
}>;

export type ProposalApproval = Readonly<{
  operatorId: string;
  proposalDigest: string;
  approvedAt: string;
}>;

export type StoredProposal = Readonly<{
  proposal: InstructionProposal;
  digest: string;
  status: ProposalStatus;
  validationErrors: readonly string[];
  approval?: ProposalApproval;
  rejectionReason?: string;
  signedEnvelopeId?: string;
}>;

export type ProposalStoreSnapshot = Readonly<{ proposals: readonly StoredProposal[] }>;
