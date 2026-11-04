import { randomUUID } from "node:crypto";
import type { PayPalSandboxPaymentLinksAdapter } from "../adapters/paypal-sandbox.js";
import { verifyEnvelope } from "../crypto/signer.js";
import type { Stage1Persistence } from "../persistence/contracts.js";
import type { LocalProposalStore } from "../proposals/local-proposal-store.js";

export type PaymentLinkCollection = Readonly<{
  envelopeId: string; paymentLinkId: string; paymentLink?: string; amount: { currency: string; value: string }; merchantId?: string;
  resourceStatus: string; createdAt: string; collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT"; correlationStatus: "PAYMENT_LINK_BINDING_UNPROVEN";
}>;
export type PaymentLinkVerification = Readonly<{
  envelopeId: string; paymentLinkId: string; resourceStatus: string; checkedAt: string; collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT";
  correlationStatus: "PAYMENT_LINK_BINDING_UNPROVEN"; verificationState: "REJECTED_FOR_AUTHORISATION"; reason: "PAYMENT_LINK_BINDING_UNPROVEN";
}>;

/** A resource or redirect cannot establish a payment-to-envelope binding for a reusable Payment Link. */
export class PayPalPaymentLinkCollectionService {
  constructor(private readonly ledger: Stage1Persistence, private readonly proposals: LocalProposalStore, private readonly publicKey: string, private readonly paymentLinks: PayPalSandboxPaymentLinksAdapter, private readonly expectedMerchantId?: string) {}

  async create(proposalId: string, returnUrl: string): Promise<PaymentLinkCollection> {
    const candidate = await this.proposals.get(proposalId);
    if (candidate?.signedEnvelopeId && (await this.ledger.snapshot()).paymentLinkBindings.some((binding) => binding.envelopeId === candidate.signedEnvelopeId)) throw new Error("PAYMENT_LINK_ALREADY_CREATED_FOR_ENVELOPE");
    const stored = await this.requireApprovedSignedProposal(proposalId); const envelope = stored.proposal.envelope;
    const amount = envelope.paymentIntent.acceptedAmounts.maximum;
    const created = await this.paymentLinks.createReusableLink({ name: "HBIEPA Sandbox demonstration collection — no remittance or payout", amount, returnUrl });
    if (!created.id) throw new Error("PAYPAL_PAYMENT_LINK_RESOURCE_ID_MISSING");
    const paymentLink = created.payment_link ?? created.links?.find((link) => link.rel === "approve" || link.rel === "payer-action" || link.rel === "self")?.href;
    const result: PaymentLinkCollection = { envelopeId: envelope.envelopeId, paymentLinkId: created.id, paymentLink, amount, merchantId: this.expectedMerchantId, resourceStatus: resourceStatus(created), createdAt: new Date().toISOString(), collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT", correlationStatus: "PAYMENT_LINK_BINDING_UNPROVEN" };
    await this.ledger.bindPayPalPaymentLink({ envelopeId: result.envelopeId, paymentLinkId: result.paymentLinkId, paymentLinkUrl: result.paymentLink, expectedAmount: result.amount, expectedMerchantId: result.merchantId, resourceStatus: result.resourceStatus, correlationStatus: result.correlationStatus, createdAt: result.createdAt });
    await this.ledger.advanceState(envelope.envelopeId, "SIGNED", "PAYMENT_PENDING");
    await this.audit(envelope.envelopeId, "CREATE_PAYPAL_SANDBOX_PAYMENT_LINK", "INFO", created.id);
    return result;
  }

  async verify(proposalId: string): Promise<PaymentLinkVerification> {
    const stored = await this.proposals.get(proposalId); if (!stored?.signedEnvelopeId) throw new Error("SIGNED_ENVELOPE_REQUIRED");
    const binding = (await this.ledger.snapshot()).paymentLinkBindings.find((item) => item.envelopeId === stored.signedEnvelopeId); if (!binding) throw new Error("PAYMENT_LINK_NOT_CREATED_FOR_ENVELOPE");
    const resource = await this.paymentLinks.getPaymentLink(binding.paymentLinkId); if (resource.id !== binding.paymentLinkId) throw new Error("PAYMENT_LINK_RESOURCE_ID_MISMATCH");
    const result: PaymentLinkVerification = { envelopeId: binding.envelopeId, paymentLinkId: binding.paymentLinkId, resourceStatus: resourceStatus(resource), checkedAt: new Date().toISOString(), collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT", correlationStatus: "PAYMENT_LINK_BINDING_UNPROVEN", verificationState: "REJECTED_FOR_AUTHORISATION", reason: "PAYMENT_LINK_BINDING_UNPROVEN" };
    await this.audit(binding.envelopeId, "VERIFY_PAYPAL_SANDBOX_PAYMENT_LINK", "DENY", binding.paymentLinkId); return result;
  }

  private async requireApprovedSignedProposal(proposalId: string) {
    const stored = await this.proposals.get(proposalId);
    if (!stored || stored.status !== "SIGNED" || !stored.approval || stored.approval.proposalDigest !== stored.digest || !stored.signedEnvelopeId) throw new Error("HUMAN_APPROVED_SIGNED_PROPOSAL_REQUIRED");
    const instruction = await this.ledger.getInstruction(stored.signedEnvelopeId); const signed = instruction?.versions[0]?.envelope;
    if (!signed || instruction?.state !== "SIGNED" || !verifyEnvelope(signed, this.publicKey)) throw new Error("SIGNATURE_INVALID"); return stored;
  }

  private async audit(envelopeId: string, action: string, outcome: "DENY" | "INFO", providerId: string): Promise<void> {
    await this.ledger.appendAudit({ eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId, actorType: "PROVIDER", action, outcome, correlationId: envelopeId, evidenceDigest: providerId });
  }
}
function resourceStatus(resource: { status?: unknown; reusable?: unknown }): string { return typeof resource.status === "string" ? resource.status : typeof resource.reusable === "string" ? `REUSABLE_${resource.reusable}` : "RESOURCE_STATUS_UNAVAILABLE"; }
