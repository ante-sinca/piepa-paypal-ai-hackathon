import type { InstructionProposal } from "./contracts.js";
import { PROPOSAL_SCHEMA_VERSION } from "./contracts.js";
import { validateEnvelope, type ValidationResult } from "../policy/validator.js";

export type ProposalValidationResult = Readonly<ValidationResult & { warnings: readonly string[] }>;

const supportedCurrencies = new Set(["GBP"]);

/** The AI response is untrusted; this code, not an agent, decides whether it is actionable. */
export function validateProposal(proposal: InstructionProposal, now = new Date()): ProposalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (proposal.schemaVersion !== PROPOSAL_SCHEMA_VERSION) errors.push("UNSUPPORTED_PROPOSAL_SCHEMA");
  if (proposal.collection.provider !== "paypal-sandbox") errors.push("UNSUPPORTED_COLLECTION_PROVIDER");
  if (!proposal.paymentPurpose.trim()) errors.push("PAYMENT_PURPOSE_REQUIRED");
  if (!proposal.collection.amount || !proposal.collection.currency) errors.push("COLLECTION_AMOUNT_AND_CURRENCY_REQUIRED");
  if (proposal.collection.currency && !supportedCurrencies.has(proposal.collection.currency)) errors.push("UNSUPPORTED_COLLECTION_CURRENCY");
  if (proposal.missingInformation.length) errors.push(...proposal.missingInformation.map((item) => `MISSING_INFORMATION:${item}`));
  if (proposal.unsupportedAssumptions.length) errors.push(...proposal.unsupportedAssumptions.map((item) => `UNSUPPORTED_ASSUMPTION:${item}`));
  if (proposal.purpose === "PHILIPPINES_CONDITIONAL_PAYOUT" && !proposal.beneficiary.reference) errors.push("BENEFICIARY_REFERENCE_REQUIRED");
  if (proposal.purpose === "PHILIPPINES_CONDITIONAL_PAYOUT" && proposal.beneficiary.country !== "PH") errors.push("PHILIPPINES_DESTINATION_REQUIRED");
  if (proposal.purpose === "INSTITUTIONAL_DONATION" && !proposal.beneficiary.reference) errors.push("INSTITUTIONAL_RECIPIENT_REQUIRED");
  if (proposal.purpose === "PHILIPPINES_CONDITIONAL_PAYOUT" && proposal.downstreamAction !== "AUTHORISE_SIMULATED_PAYOUT") errors.push("PAYOUT_ACTION_REQUIRED");
  if (proposal.purpose === "INSTITUTIONAL_DONATION" && proposal.downstreamAction !== "RECORD_DONATION_ELIGIBILITY") errors.push("DONATION_ELIGIBILITY_ACTION_REQUIRED");
  if (proposal.downstreamAction === "AUTHORISE_SIMULATED_PAYOUT" && (!proposal.executionRestrictions.includes("SIMULATION_ONLY") || !proposal.executionRestrictions.includes("SINGLE_USE_AUTHORISATION") || !proposal.executionRestrictions.includes("NO_EXTERNAL_PAYOUT"))) errors.push("SIMULATION_EXECUTION_RESTRICTIONS_REQUIRED");
  const envelope = validateEnvelope(proposal.envelope, now);
  errors.push(...envelope.errors.map((error) => `ENVELOPE:${error}`));
  if (proposal.provenance === "SYNTHETIC_AI_DEMO") warnings.push("SYNTHETIC_AI_DEMO_RESPONSE");
  if (proposal.purpose === "INSTITUTIONAL_DONATION") warnings.push("PROPOSAL_ONLY_NO_COLLECTION_OR_EXECUTION");
  return { valid: errors.length === 0, errors, warnings };
}
