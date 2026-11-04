import { verifyEnvelope } from "../crypto/signer.js";
import type { Stage1Persistence } from "../persistence/contracts.js";
import { LocalProposalStore } from "../proposals/local-proposal-store.js";

export type AuthoritativeTransactionStatus = Readonly<{
  envelopeId: string;
  transactionType: "PHILIPPINE_PAYOUT" | "INSTITUTIONAL_DONATION";
  ledgerState: string;
  displayStatus: string;
  paymentKind: "GENUINE_PAYPAL_SANDBOX_PAYMENT" | "SYNTHETIC_DEMO_PAYMENT" | "PAYMENT_NOT_VERIFIED";
  steps: Readonly<{ generated: boolean; validated: boolean; humanApproval: boolean; signature: boolean; payment: boolean; policy: boolean; authorisation: boolean; execution: boolean; reconciliation: boolean }>;
  receipt: Readonly<{
    collection?: string;
    paymentProvider?: string;
    paymentStatus?: string;
    paypalOrderId?: string;
    paypalMerchantId?: string;
    paypalCaptureId?: string;
    captureReference?: string;
    recipientReference?: string;
    signature: "Ed25519 verified" | "Not verified";
    authorisation: "Approved" | "Consumed" | "Not authorised";
    executionReference?: string;
    reconciliation: string;
  }>;
}>;

/** Read-only projection of the existing proposal and ledger records for the switchboard. */
export class TransactionStatusService {
  constructor(private readonly ledger: Stage1Persistence, private readonly proposals: LocalProposalStore, private readonly publicKey: string) {}

  async forProposal(proposalId: string): Promise<AuthoritativeTransactionStatus> {
    const stored = await this.proposals.get(proposalId);
    if (!stored) throw new Error("UNKNOWN_PROPOSAL");
    const envelopeId = stored.proposal.envelope.envelopeId; const snapshot = await this.ledger.snapshot();
    const instruction = snapshot.instructions.find((item) => item.envelopeId === envelopeId);
    const version = instruction?.versions[0]; const signature = Boolean(version && verifyEnvelope(version.envelope, this.publicKey));
    const humanApproval = Boolean(stored.approval && stored.approval.proposalDigest === stored.digest);
    const evidence = snapshot.paymentEvidence.find((item) => item.envelopeId === envelopeId);
    const binding = snapshot.orderBindings.find((item) => item.envelopeId === envelopeId);
    const decision = evidence ? snapshot.policyDecisions.find((item) => item.envelopeId === envelopeId && item.paymentEvidenceId === evidence.evidenceId) : undefined;
    const authorisation = snapshot.authorisations.find((item) => item.envelopeId === envelopeId);
    const execution = authorisation ? snapshot.executionAttempts.find((item) => item.authorisationId === authorisation.authorisationId) : undefined;
    const reconciliation = [...snapshot.reconciliations].reverse().find((item) => item.envelopeId === envelopeId);
    const genuine = evidence?.evidence.provider === "paypal-sandbox" && evidence.evidence.isSynthetic === false;
    const synthetic = evidence?.evidence.isSynthetic === true && evidence.evidence.status === "COMPLETED";
    const payment = Boolean((genuine && binding && evidence.evidence.resourceId === binding.orderId && evidence.evidence.correlationId === binding.correlationId && evidence.evidence.status === "COMPLETED") || synthetic);
    const policy = decision?.outcome === "ALLOW_SIMULATION";
    const executionSucceeded = execution?.outcome === "SUCCEEDED";
    const reconciled = reconciliation?.status === "RECONCILED" && payment && policy && Boolean(authorisation) && executionSucceeded;
    const displayStatus = reconciled ? "RECONCILED" : instruction?.state ?? stored.status;
    return {
      envelopeId, transactionType: stored.proposal.purpose === "PHILIPPINES_CONDITIONAL_PAYOUT" ? "PHILIPPINE_PAYOUT" : "INSTITUTIONAL_DONATION",
      ledgerState: instruction?.state ?? "NO_LEDGER_RECORD", displayStatus,
      paymentKind: genuine ? "GENUINE_PAYPAL_SANDBOX_PAYMENT" : evidence?.evidence.isSynthetic ? "SYNTHETIC_DEMO_PAYMENT" : "PAYMENT_NOT_VERIFIED",
      steps: { generated: true, validated: stored.validationErrors.length === 0, humanApproval, signature, payment, policy, authorisation: Boolean(authorisation), execution: executionSucceeded, reconciliation: reconciled },
      receipt: {
        collection: stored.proposal.collection.amount && stored.proposal.collection.currency ? `${stored.proposal.collection.currency} ${stored.proposal.collection.amount}` : undefined,
        paymentProvider: genuine ? "PayPal Sandbox" : evidence?.evidence.isSynthetic ? "Synthetic demo" : undefined,
        paymentStatus: genuine && payment ? "Completed — independently verified capture" : synthetic ? "Completed — synthetic demo evidence" : evidence?.evidence.status,
        paypalOrderId: genuine && payment ? binding?.orderId : undefined,
        paypalMerchantId: genuine && payment ? evidence?.evidence.merchantId : undefined,
        paypalCaptureId: genuine && payment ? evidence?.evidence.captureId : undefined,
        captureReference: genuine && payment ? evidence?.evidence.captureId : undefined,
        recipientReference: stored.proposal.beneficiary.reference,
        signature: signature ? "Ed25519 verified" : "Not verified",
        authorisation: authorisation?.state === "CONSUMED" ? "Consumed" : authorisation ? "Approved" : "Not authorised",
        executionReference: execution?.providerReference,
        reconciliation: reconciliation?.status ?? "Pending",
      },
    };
  }
}
