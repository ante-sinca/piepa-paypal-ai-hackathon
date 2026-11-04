import { randomUUID } from "node:crypto";
import type { EnvelopePayload } from "../contracts/envelope.js";
import type { InstructionDraftingAgent } from "./contracts.js";
import type { InstructionProposal } from "../proposals/contracts.js";
import { PROPOSAL_SCHEMA_VERSION } from "../proposals/contracts.js";

const amountFrom = (text: string): string | undefined => text.match(/(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i)?.[1];
const hasManipulation = (text: string) => /bypass|ignore (?:policy|approval|validation)|override|without (?:approval|verification)/i.test(text);

/** Offline fixture-style demonstrator. It is intentionally labelled synthetic and makes no network call. */
export class SyntheticInstructionDraftingAgent implements InstructionDraftingAgent {
  readonly provenance = "SYNTHETIC_AI_DEMO" as const;

  async draft(input: Readonly<{ instruction: string; now?: Date }>): Promise<InstructionProposal> {
    const now = input.now ?? new Date();
    const donation = /donation|institution/i.test(input.instruction);
    const amount = amountFrom(input.instruction);
    const manipulation = hasManipulation(input.instruction);
    const beneficiaryReference = input.instruction.match(/beneficiary(?:\s+(?:reference|id))?\s*[:#]\s*([A-Za-z0-9_-](?:[A-Za-z0-9._-]{1,126}[A-Za-z0-9_-])?)/i)?.[1];
    const institutionalRecipient = input.instruction.match(/(?:institution(?:al)?\s+)?recipient(?:\s+(?:reference|id))?\s*[:#]\s*([A-Za-z0-9_-](?:[A-Za-z0-9._-]{1,126}[A-Za-z0-9_-])?)/i)?.[1];
    const missing: string[] = [];
    if (!amount) missing.push("collection_amount");
    const recipientReference = donation ? institutionalRecipient : beneficiaryReference;
    if (!recipientReference) missing.push(donation ? "institutional_recipient" : "beneficiary_reference");
    if (!donation && !/philippine|philippines/i.test(input.instruction)) missing.push("beneficiary_country");
    const unsupported = manipulation ? ["AI_POLICY_MANIPULATION_ATTEMPT"] : [];
    const envelopeId = `demo-${randomUUID()}`;
    const value = amount ?? "1.00";
    const envelopeBeneficiaryReference = recipientReference ?? (donation ? "institution-recipient-pending" : "beneficiary-pending");
    const purpose = donation ? "INSTITUTIONAL_DONATION" as const : "PHILIPPINES_CONDITIONAL_PAYOUT" as const;
    const envelope: EnvelopePayload = {
      envelopeId, version: "1.0", issuerId: "hbiepa-demo-operator", authorisedPartyId: "hbiepa-demo-operator",
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), nonce: randomUUID(),
      paymentIntent: { collectionPurpose: donation ? "institutional donation designation" : "conditional Philippine payout funding", acceptedAmounts: { minimum: { currency: "GBP", value }, maximum: { currency: "GBP", value } }, permittedPaymentProviders: ["paypal-sandbox"] },
      beneficiary: { beneficiaryReference: envelopeBeneficiaryReference, destinationType: "MOCK", destinationReference: donation ? "proposal-only" : "simulated-philippines-destination", destinationCountry: donation ? "GB" : "PH" },
      permittedActions: donation ? ["COLLECT_PAYMENT", "VERIFY_PAYMENT"] : ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
      requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "HUMAN_APPROVAL_RECORDED"],
      authorisationPolicyRef: donation ? "stage2a-donation-proposal-only" : "stage2a-synthetic-demo-policy", execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency: "GBP", value }, oneTimeAuthorisationRequired: true }, auditReference: `audit-${envelopeId}`, reconciliationReference: `reconcile-${envelopeId}`,
    };
    return {
      proposalId: `proposal-${randomUUID()}`, version: 1, schemaVersion: PROPOSAL_SCHEMA_VERSION, createdAt: now.toISOString(), sourceText: input.instruction, provenance: this.provenance, purpose,
      collection: { provider: "paypal-sandbox", ...(amount ? { amount, currency: "GBP" } : {}) }, paymentPurpose: envelope.paymentIntent.collectionPurpose,
      beneficiary: { ...(!missing.includes(donation ? "institutional_recipient" : "beneficiary_reference") && !missing.includes("beneficiary_country") ? { reference: recipientReference, country: donation ? "GB" : "PH", destinationType: "MOCK" as const } : {}) },
      downstreamAction: donation ? "RECORD_DONATION_ELIGIBILITY" : "AUTHORISE_SIMULATED_PAYOUT", requiredVerification: envelope.requiredVerification,
      authorisationRequirements: ["EXPLICIT_HUMAN_APPROVAL", "SIGNED_ENVELOPE", "DETERMINISTIC_POLICY_ALLOW"], executionRestrictions: ["SIMULATION_ONLY", "SINGLE_USE_AUTHORISATION", "NO_EXTERNAL_PAYOUT"], missingInformation: missing, unsupportedAssumptions: unsupported, envelope,
    };
  }
}
