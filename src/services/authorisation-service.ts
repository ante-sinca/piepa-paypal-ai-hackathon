import { randomUUID } from "node:crypto";
import type { CurrencyAmount, PayoutAuthorisation } from "../contracts/envelope.js";
import { canonicalJson, sha256Base64Url } from "../crypto/canonical-json.js";
import type { StoredPaymentEvidence } from "../persistence/local-ledger.js";
import type { Stage1Persistence } from "../persistence/contracts.js";
import { evaluateSandboxPolicy, type SandboxPolicyDecision } from "../policy/engine.js";

export class AuthorisationService {
  constructor(private readonly ledger: Stage1Persistence) {}

  async evaluateAndAuthorise(input: Readonly<{
    envelopeId: string;
    publicKeyValid: boolean;
    humanApprovalRecorded: boolean;
    paymentEvidence: StoredPaymentEvidence;
    intendedBeneficiaryReference: string;
    intendedPayout: CurrencyAmount;
    providerEligibilityEvidence: boolean;
    expiresAt: string;
    now?: Date;
  }>): Promise<{ decision: SandboxPolicyDecision; authorisation?: PayoutAuthorisation }> {
    const snapshot = await this.ledger.snapshot();
    const instruction = snapshot.instructions.find((item) => item.envelopeId === input.envelopeId);
    if (!instruction?.versions[0]) throw new Error("A signed envelope is required for authorisation");
    const binding = snapshot.orderBindings.find((item) => item.envelopeId === input.envelopeId);
    const decision = evaluateSandboxPolicy({
      envelope: instruction.versions[0].envelope.payload, signatureValid: input.publicKeyValid, humanApprovalRecorded: input.humanApprovalRecorded,
      payment: input.paymentEvidence.evidence, binding, intendedBeneficiaryReference: input.intendedBeneficiaryReference,
      intendedPayout: input.intendedPayout, providerEligibilityEvidence: input.providerEligibilityEvidence,
      alreadyAuthorised: snapshot.authorisations.some((item) => item.envelopeId === input.envelopeId), now: input.now,
    });
    await this.ledger.recordPolicyDecision({ ...decision, envelopeId: input.envelopeId, paymentEvidenceId: input.paymentEvidence.evidenceId });
    if (decision.outcome === "DENY") return { decision };
    const issuedAt = (input.now ?? new Date()).toISOString();
    const authorisation: PayoutAuthorisation = {
      authorisationId: randomUUID(), envelopeId: input.envelopeId, envelopeVersion: instruction.versions[0].version,
      envelopeDigest: instruction.versions[0].digest, paymentEvidenceId: input.paymentEvidence.evidenceId,
      beneficiaryReference: input.intendedBeneficiaryReference, payoutAmount: input.intendedPayout, payoutProvider: "mock-philippines",
      payoutIntentDigest: sha256Base64Url(canonicalJson({ envelopeId: input.envelopeId, paymentEvidenceId: input.paymentEvidence.evidenceId, beneficiaryReference: input.intendedBeneficiaryReference, payoutAmount: input.intendedPayout, provider: "mock-philippines" })),
      createdAt: issuedAt, expiresAt: input.expiresAt, executionId: randomUUID(), state: "AUTHORISED",
    };
    return { decision, authorisation: await this.ledger.createAuthorisation(authorisation, decision.decisionId) };
  }
}
