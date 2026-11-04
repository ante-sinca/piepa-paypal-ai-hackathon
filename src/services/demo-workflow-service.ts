import { randomUUID } from "node:crypto";
import type { PayoutAuthorisation } from "../contracts/envelope.js";
import { canonicalJson, sha256Base64Url } from "../crypto/canonical-json.js";
import { EnvelopeService } from "./envelope-service.js";
import type { Stage1Persistence } from "../persistence/contracts.js";
import type { StoredPaymentEvidence } from "../persistence/local-ledger.js";
import { evaluateSyntheticDemoPolicy } from "../policy/synthetic-demo-policy.js";
import { LocalProposalStore } from "../proposals/local-proposal-store.js";
import { validateProposal } from "../proposals/validator.js";
import type { InstructionDraftingAgent } from "../ai/contracts.js";
import { SyntheticPaymentVerificationAdapter } from "../simulation/synthetic-payment-verifier.js";
import { MockPhilippinesPayoutAdapter } from "../simulation/mock-philippines-payout.js";
import { reconcileSyntheticDemoEnvelope } from "../reconciliation/synthetic-demo-reconciliation.js";

export class DemoWorkflowService {
  private readonly envelopes: EnvelopeService;
  private readonly verifier = new SyntheticPaymentVerificationAdapter();
  private readonly payouts: MockPhilippinesPayoutAdapter;
  constructor(private readonly ledger: Stage1Persistence, private readonly proposals: LocalProposalStore, private readonly agent: InstructionDraftingAgent, private readonly keys: Readonly<{ privateKeyPem: string; publicKeyPem: string; keyId: string }>) {
    this.envelopes = new EnvelopeService(ledger); this.payouts = new MockPhilippinesPayoutAdapter(ledger);
  }
  async generate(instruction: string) { return this.proposals.create(await this.agent.draft({ instruction })); }
  async approve(proposalId: string, operatorId = "demo-operator") { return this.proposals.approve(proposalId, operatorId); }
  async reject(proposalId: string, reason: string) { return this.proposals.reject(proposalId, reason); }
  async amend(proposalId: string, replacement: Parameters<LocalProposalStore["amend"]>[1]) { return this.proposals.amend(proposalId, replacement); }
  async amendFromInstruction(proposalId: string, instruction: string) {
    return this.proposals.amend(proposalId, await this.agent.draft({ instruction }));
  }
  async sign(proposalId: string) {
    const stored = await this.require(proposalId);
    const validation = validateProposal(stored.proposal);
    if (stored.status !== "APPROVED" || !stored.approval || stored.approval.proposalDigest !== stored.digest || !validation.valid) throw new Error("Human approval of the exact valid proposal is required before signing");
    await this.envelopes.createUnsignedDraft(stored.proposal.envelope);
    await this.envelopes.validateDraft(stored.proposal.envelope.envelopeId);
    const signed = await this.envelopes.signValidatedDraft(stored.proposal.envelope.envelopeId, this.keys.privateKeyPem, this.keys.keyId);
    const verification = await this.envelopes.verifySignedEnvelope(signed.payload.envelopeId, { [this.keys.keyId]: this.keys.publicKeyPem });
    if (!verification.valid) throw new Error("SIGNATURE_INVALID");
    await this.proposals.markSigned(proposalId);
    return signed;
  }
  async runSyntheticDemo(proposalId: string) {
    const stored = await this.require(proposalId);
    if (stored.status !== "SIGNED" || !stored.approval) throw new Error("AUTHORISATION_DENIED: signed, human-approved proposal required");
    const envelopeId = stored.proposal.envelope.envelopeId;
    const verified = await this.envelopes.verifySignedEnvelope(envelopeId, { [this.keys.keyId]: this.keys.publicKeyPem });
    if (!verified.valid || !verified.envelope) throw new Error("SIGNATURE_INVALID");
    await this.envelopes.openPaymentCollection(envelopeId);
    const verification = this.verifier.verify(verified.envelope.payload, {});
    if (!verification.accepted) throw new Error(verification.reason ?? "PAYMENT_BINDING_REJECTED");
    const payment = await this.ledger.storePaymentEvidence(envelopeId, verification.evidence, JSON.stringify(verification.evidence));
    await this.envelopes.markPaymentVerified(envelopeId);
    const authorisation = await this.authorise(verified.envelope.payload, payment, stored.approval.operatorId, verified.valid);
    const execution = await this.payouts.execute(authorisation, "SUCCEEDED");
    const reconciliation = await reconcileSyntheticDemoEnvelope(this.ledger, envelopeId);
    return { envelope: verified.envelope, payment, authorisation, execution, reconciliation };
  }
  async runPaymentMismatch(proposalId: string) {
    const stored = await this.require(proposalId); const verification = this.verifier.verify(stored.proposal.envelope, { amount: { currency: "GBP", value: "999.00" } });
    return verification.accepted ? "UNEXPECTED_ACCEPTANCE" : verification.reason;
  }
  async audit(envelopeId: string) { const snapshot = await this.ledger.snapshot(); return { instruction: snapshot.instructions.find((item) => item.envelopeId === envelopeId), evidence: snapshot.paymentEvidence.filter((item) => item.envelopeId === envelopeId), decisions: snapshot.policyDecisions.filter((item) => item.envelopeId === envelopeId), authorisations: snapshot.authorisations.filter((item) => item.envelopeId === envelopeId), executions: snapshot.executionAttempts, reconciliations: snapshot.reconciliations.filter((item) => item.envelopeId === envelopeId), events: snapshot.auditEvents.filter((item) => item.envelopeId === envelopeId) }; }
  private async authorise(envelope: NonNullable<Awaited<ReturnType<EnvelopeService["verifySignedEnvelope"]>>["envelope"]>["payload"], payment: StoredPaymentEvidence, operatorId: string, signatureValid: boolean): Promise<PayoutAuthorisation> {
    const snapshot = await this.ledger.snapshot();
    const decision = evaluateSyntheticDemoPolicy({ envelope, signatureValid, humanApprovalRecorded: Boolean(operatorId), payment: payment.evidence, intendedBeneficiaryReference: envelope.beneficiary.beneficiaryReference, intendedPayout: envelope.execution.maxPayout, alreadyAuthorised: snapshot.authorisations.some((item) => item.envelopeId === envelope.envelopeId) });
    await this.ledger.recordPolicyDecision({ ...decision, envelopeId: envelope.envelopeId, paymentEvidenceId: payment.evidenceId });
    if (decision.outcome === "DENY") throw new Error(`AUTHORISATION_DENIED:${decision.reasons.join(",")}`);
    const now = new Date();
    const authorisation: PayoutAuthorisation = { authorisationId: randomUUID(), envelopeId: envelope.envelopeId, envelopeVersion: "1.0", envelopeDigest: (await this.requireByEnvelope(envelope.envelopeId)).digest, paymentEvidenceId: payment.evidenceId, beneficiaryReference: envelope.beneficiary.beneficiaryReference, payoutAmount: envelope.execution.maxPayout, payoutProvider: "mock-philippines", payoutIntentDigest: sha256Base64Url(canonicalJson({ envelopeId: envelope.envelopeId, paymentEvidenceId: payment.evidenceId, beneficiaryReference: envelope.beneficiary.beneficiaryReference, payoutAmount: envelope.execution.maxPayout, provider: "mock-philippines" })), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), executionId: randomUUID(), state: "AUTHORISED" };
    return this.ledger.createAuthorisation(authorisation, decision.decisionId);
  }
  private async require(proposalId: string) { const found = await this.proposals.get(proposalId); if (!found) throw new Error("Unknown proposal"); return found; }
  private async requireByEnvelope(envelopeId: string) { const found = (await this.proposals.list()).find((item) => item.proposal.envelope.envelopeId === envelopeId); if (!found) throw new Error("Proposal missing for envelope"); return found; }
}
