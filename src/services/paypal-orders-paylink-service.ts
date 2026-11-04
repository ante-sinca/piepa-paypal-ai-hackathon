import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PayPalSandboxApiError, type PayPalSandboxOrdersAdapter } from "../adapters/paypal-sandbox.js";
import type { CurrencyAmount, PayoutAuthorisation } from "../contracts/envelope.js";
import { verifyEnvelope } from "../crypto/signer.js";
import type { Stage1Persistence } from "../persistence/contracts.js";
import type { PayPalOrderPaymentSession, StoredPaymentEvidence } from "../persistence/local-ledger.js";
import { LocalProposalStore } from "../proposals/local-proposal-store.js";
import { AuthorisationService } from "./authorisation-service.js";
import { MockPhilippinesPayoutAdapter } from "../simulation/mock-philippines-payout.js";
import { reconcileEnvelope } from "../reconciliation/engine.js";
import { EnvelopeService } from "./envelope-service.js";

export type OrdersPaymentSession = Readonly<{
  sessionToken?: string;
  sessionPath?: string;
  expiresAt: string;
  amount: CurrencyAmount;
  orderId: string;
  approvalUrl: string;
  recovery: "CREATED" | "RECOVERED_READY";
  collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT";
  initialInspection?: OrdersPaymentSessionInspection;
}>;

export type PublicOrdersPaymentSession = Readonly<{
  amount: CurrencyAmount;
  expiresAt: string;
  checkoutPath: string;
  collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT";
}>;

/** Read-only, safe-to-display projection of an existing Orders v2 session. */
export type OrdersPaymentSessionInspection = Readonly<{
  availability: "CHECKOUT_READY" | "PAYMENT_APPROVED" | "PAYMENT_COMPLETED" | "ORDER_UNUSABLE" | "ORDER_NOT_FOUND" | "ORDER_BINDING_MISMATCH" | "PAYMENT_SESSION_INVALID_OR_EXPIRED" | "PROVIDER_STATUS_UNAVAILABLE";
  providerStatus?: string;
  providerFailure?: "PAYPAL_RESOURCE_NOT_FOUND" | "PAYPAL_PROVIDER_STATUS_UNAVAILABLE";
  captureExists: boolean;
}>;

/**
 * A local pay-by-link shell for one Orders v2 resource.  The random URL token
 * is capability-like, stored only as a SHA-256 digest, and maps to the
 * existing Order/correlation binding rather than becoming a financial record.
 */
export class PayPalOrdersPayLinkService {
  constructor(
    private readonly ledger: Stage1Persistence,
    private readonly proposals: LocalProposalStore,
    private readonly publicKey: string,
    private readonly paypal: PayPalSandboxOrdersAdapter,
    private readonly expectedMerchantId: string,
    private readonly preflight?: () => Promise<Readonly<{ status: "PASS" | "FAIL"; reasons: readonly string[] }>>,
  ) {}

  async create(proposalId: string, returnUrl: string, cancelUrl: string): Promise<OrdersPaymentSession> {
    const stored = await this.requireProposal(proposalId, ["SIGNED"]);
    const envelope = stored.proposal.envelope;
    const snapshot = await this.ledger.snapshot();
    const existing = snapshot.orderPaymentSessions.find((item) => item.envelopeId === envelope.envelopeId);
    if (existing?.status === "READY" && existing.orderId && existing.approvalUrl) return this.recoveredReady(existing);
    const sessionToken = existing ? undefined : randomBytes(32).toString("base64url");
    const reserved: PayPalOrderPaymentSession = existing ?? {
      envelopeId: envelope.envelopeId, sessionTokenDigest: tokenDigest(sessionToken!), correlationId: `hbiepa-order-${randomUUID()}`, createRequestId: `hbiepa-order-${randomUUID()}`,
      expectedAmount: envelope.paymentIntent.acceptedAmounts.maximum, expectedMerchantId: this.expectedMerchantId, applicationClientIdFingerprint: this.paypal.clientIdFingerprint,
      expiresAt: envelope.expiresAt, createdAt: new Date().toISOString(), status: "PENDING_ORDER",
    };
    if (!existing) await this.ledger.reservePayPalOrderPaymentSession(reserved);
    const preflight = await this.preflight?.();
    if (preflight?.status === "FAIL") throw new Error(`PAYPAL_SANDBOX_PREFLIGHT_FAILED:${preflight.reasons.join(",") || "UNKNOWN"}`);
    let created: { orderId: string; approvalUrl?: string };
    try {
      created = await this.paypal.createOrder({ correlationId: reserved.correlationId, amount: reserved.expectedAmount, returnUrl, cancelUrl, merchantId: this.expectedMerchantId, requestId: reserved.createRequestId });
    } catch (error) {
      if (error instanceof Error && (/PAYPAL_SANDBOX_(OAUTH|ORDERS)_TIMEOUT/.test(error.message) || /PayPal sandbox transport failure/.test(error.message))) throw new Error("PAYMENT_SESSION_OUTCOME_REQUIRES_VERIFICATION");
      throw error;
    }
    if (!created.orderId || !created.approvalUrl) throw new Error("PAYPAL_ORDER_APPROVAL_URL_MISSING");
    try {
      await this.ledger.bindPayPalOrder({ envelopeId: envelope.envelopeId, orderId: created.orderId, correlationId: reserved.correlationId, expectedAmount: reserved.expectedAmount, expectedMerchantId: this.expectedMerchantId, createdAt: reserved.createdAt });
      await this.ledger.activatePayPalOrderPaymentSession(envelope.envelopeId, reserved.correlationId, created.orderId, created.approvalUrl);
      await this.ledger.advanceState(envelope.envelopeId, "SIGNED", "PAYMENT_PENDING");
      await this.audit(envelope.envelopeId, "CREATE_PAYPAL_ORDERS_PAYMENT_SESSION", "INFO", reserved.correlationId);
    } catch {
      const ready = (await this.ledger.snapshot()).orderPaymentSessions.find((item) => item.envelopeId === envelope.envelopeId);
      if (ready?.status === "READY" && ready.orderId === created.orderId && ready.approvalUrl) return this.recoveredReady(ready);
      throw new Error("PAYMENT_SESSION_OUTCOME_REQUIRES_VERIFICATION");
    }
    const initialInspection = await this.inspect(proposalId);
    await this.audit(envelope.envelopeId, `INITIAL_PAYPAL_ORDER_RETRIEVAL_${initialInspection.availability}`, initialInspection.availability === "CHECKOUT_READY" ? "INFO" : "DENY", created.orderId);
    return { sessionToken, sessionPath: sessionToken ? `/pay/${sessionToken}` : undefined, expiresAt: reserved.expiresAt, amount: reserved.expectedAmount, orderId: created.orderId, approvalUrl: created.approvalUrl, recovery: sessionToken ? "CREATED" : "RECOVERED_READY", collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT", initialInspection };
  }

  async publicSession(sessionToken: string, now = new Date()): Promise<PublicOrdersPaymentSession> {
    const session = await this.sessionForToken(sessionToken, now);
    return { amount: session.expectedAmount, expiresAt: session.expiresAt, checkoutPath: `/pay/${sessionToken}/checkout`, collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT" };
  }

  async checkoutUrl(sessionToken: string, now = new Date()): Promise<string> {
    const session = await this.sessionForToken(sessionToken, now);
    if (!session.approvalUrl) throw new Error("PAYMENT_SESSION_CHECKOUT_UNAVAILABLE");
    return session.approvalUrl;
  }

  /** Retrieves only the existing bound Order; it never captures or mutates records. */
  async inspect(proposalId: string, now = new Date()): Promise<OrdersPaymentSessionInspection> {
    const stored = await this.requireProposal(proposalId, ["SIGNED"]);
    const snapshot = await this.ledger.snapshot(); const envelopeId = stored.proposal.envelope.envelopeId;
    const session = snapshot.orderPaymentSessions.find((item) => item.envelopeId === envelopeId);
    const binding = snapshot.orderBindings.find((item) => item.envelopeId === envelopeId);
    if (!session || !binding || session.status !== "READY" || !session.orderId || session.orderId !== binding.orderId || expired(session.expiresAt, now)) {
      return { availability: "PAYMENT_SESSION_INVALID_OR_EXPIRED", captureExists: false };
    }
    let order: Awaited<ReturnType<PayPalSandboxOrdersAdapter["getOrder"]>>;
    try { order = await this.paypal.getOrder(binding.orderId); } catch (error) {
      if (error instanceof PayPalSandboxApiError && error.httpStatus === 404) return { availability: "ORDER_NOT_FOUND", providerFailure: "PAYPAL_RESOURCE_NOT_FOUND", captureExists: false };
      return { availability: "PROVIDER_STATUS_UNAVAILABLE", providerFailure: "PAYPAL_PROVIDER_STATUS_UNAVAILABLE", captureExists: false };
    }
    const unit = order.purchase_units?.[0];
    const captureExists = Boolean(unit?.payments?.captures?.length);
    if (!unit || order.id !== binding.orderId || unit.custom_id !== session.correlationId || unit.amount?.currency_code !== session.expectedAmount.currency || unit.amount.value !== session.expectedAmount.value || (session.expectedMerchantId && unit.payee?.merchant_id !== session.expectedMerchantId)) {
      return { availability: "ORDER_BINDING_MISMATCH", providerStatus: order.status, captureExists };
    }
    if (order.status === "CREATED" && session.approvalUrl) return { availability: "CHECKOUT_READY", providerStatus: order.status, captureExists };
    if (order.status === "APPROVED") return { availability: "PAYMENT_APPROVED", providerStatus: order.status, captureExists };
    if (order.status === "COMPLETED") return { availability: "PAYMENT_COMPLETED", providerStatus: order.status, captureExists };
    return { availability: "ORDER_UNUSABLE", providerStatus: order.status, captureExists };
  }

  async verifyAndCapture(proposalId: string): Promise<StoredPaymentEvidence> {
    const stored = await this.requireProposal(proposalId, ["SIGNED"]);
    const envelope = stored.proposal.envelope;
    const snapshot = await this.ledger.snapshot();
    const session = snapshot.orderPaymentSessions.find((item) => item.envelopeId === envelope.envelopeId);
    const binding = snapshot.orderBindings.find((item) => item.envelopeId === envelope.envelopeId);
    if (!session || !binding || session.status !== "READY" || session.orderId !== binding.orderId || expired(session.expiresAt)) throw new Error("PAYMENT_SESSION_INVALID_OR_EXPIRED");
    const existing = snapshot.paymentEvidence.find((item) => item.envelopeId === envelope.envelopeId && item.evidence.captureId);
    if (existing) return existing;
    if (snapshot.instructions.find((item) => item.envelopeId === envelope.envelopeId)?.state !== "PAYMENT_PENDING") throw new Error("PAYMENT_SESSION_INVALID_OR_EXPIRED");
    const before = await this.paypal.getOrder(binding.orderId);
    verifyOrder(before, binding.orderId, session.correlationId, session.expectedAmount, session.expectedMerchantId, "APPROVED");
    await this.paypal.captureOrder(binding.orderId, `hbiepa-capture-${randomUUID()}`);
    const retrieved = await this.paypal.retrieveCaptureEvidence(binding.orderId);
    verifyEvidence(retrieved.evidence, binding.orderId, session.correlationId, session.expectedAmount, session.expectedMerchantId);
    const evidence = await this.ledger.storePaymentEvidence(envelope.envelopeId, retrieved.evidence, retrieved.rawOrder);
    const envelopeService = new EnvelopeService(this.ledger);
    await envelopeService.markPaymentVerified(envelope.envelopeId);
    await this.audit(envelope.envelopeId, "VERIFY_PAYPAL_ORDERS_CAPTURE", "INFO", retrieved.evidence.captureId ?? binding.orderId);
    return evidence;
  }

  async authoriseSimulation(proposalId: string, now = new Date()): Promise<PayoutAuthorisation> {
    const stored = await this.requireProposal(proposalId, ["SIGNED"]);
    const envelope = stored.proposal.envelope; const snapshot = await this.ledger.snapshot();
    const evidence = snapshot.paymentEvidence.find((item) => item.envelopeId === envelope.envelopeId && !item.evidence.isSynthetic);
    if (!evidence) throw new Error("INDEPENDENT_PAYPAL_CAPTURE_EVIDENCE_REQUIRED");
    const result = await new AuthorisationService(this.ledger).evaluateAndAuthorise({
      envelopeId: envelope.envelopeId, publicKeyValid: true, humanApprovalRecorded: Boolean(stored.approval), paymentEvidence: evidence,
      intendedBeneficiaryReference: envelope.beneficiary.beneficiaryReference, intendedPayout: envelope.execution.maxPayout,
      providerEligibilityEvidence: true, expiresAt: new Date(Math.min(Date.parse(envelope.expiresAt), now.getTime() + 15 * 60 * 1000)).toISOString(), now,
    });
    if (!result.authorisation) throw new Error(`AUTHORISATION_DENIED:${result.decision.reasons.join(",")}`);
    return result.authorisation;
  }

  async executeSimulation(proposalId: string) {
    const stored = await this.requireProposal(proposalId, ["SIGNED"]); const envelopeId = stored.proposal.envelope.envelopeId;
    const authorisation = (await this.ledger.snapshot()).authorisations.find((item) => item.envelopeId === envelopeId);
    if (!authorisation) throw new Error("SIMULATION_AUTHORISATION_REQUIRED");
    const execution = await new MockPhilippinesPayoutAdapter(this.ledger).execute(authorisation, "SUCCEEDED");
    const reconciliation = await reconcileEnvelope(this.ledger, envelopeId);
    if (reconciliation.status === "RECONCILED" && (await this.ledger.getInstruction(envelopeId))?.state === "EXECUTED") await this.ledger.advanceState(envelopeId, "EXECUTED", "RECONCILED");
    return { execution, reconciliation };
  }

  private async requireProposal(proposalId: string, allowedProposalStates: readonly ["SIGNED"]) {
    const stored = await this.proposals.get(proposalId);
    if (!stored || !allowedProposalStates.includes(stored.status as "SIGNED") || !stored.approval || stored.approval.proposalDigest !== stored.digest || !stored.signedEnvelopeId) throw new Error("HUMAN_APPROVED_SIGNED_PROPOSAL_REQUIRED");
    const instruction = await this.ledger.getInstruction(stored.signedEnvelopeId); const signed = instruction?.versions[0]?.envelope;
    if (!signed || !verifyEnvelope(signed, this.publicKey) || expired(signed.payload.expiresAt)) throw new Error("SIGNATURE_INVALID_OR_EXPIRED");
    return stored;
  }

  private async sessionForToken(sessionToken: string, now: Date): Promise<PayPalOrderPaymentSession> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error("PAYMENT_SESSION_NOT_FOUND");
    const snapshot = await this.ledger.snapshot();
    const session = snapshot.orderPaymentSessions.find((item) => item.sessionTokenDigest === tokenDigest(sessionToken));
    if (!session || session.status !== "READY" || expired(session.expiresAt, now)) throw new Error("PAYMENT_SESSION_NOT_FOUND_OR_EXPIRED");
    const instruction = snapshot.instructions.find((item) => item.envelopeId === session.envelopeId);
    if (instruction?.state !== "PAYMENT_PENDING" || !instruction.versions[0] || !verifyEnvelope(instruction.versions[0].envelope, this.publicKey)) throw new Error("PAYMENT_SESSION_NOT_FOUND_OR_EXPIRED");
    return session;
  }

  private recoveredReady(session: PayPalOrderPaymentSession): OrdersPaymentSession {
    if (!session.orderId || !session.approvalUrl) throw new Error("PAYMENT_SESSION_OUTCOME_REQUIRES_VERIFICATION");
    return { expiresAt: session.expiresAt, amount: session.expectedAmount, orderId: session.orderId, approvalUrl: session.approvalUrl, recovery: "RECOVERED_READY", collectionType: "GENUINE_PAYPAL_SANDBOX_PAYMENT" };
  }

  private async audit(envelopeId: string, action: string, outcome: "INFO" | "DENY", providerReference: string): Promise<void> {
    await this.ledger.appendAudit({ eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId, actorType: "SYSTEM", action, outcome, correlationId: envelopeId, evidenceDigest: tokenDigest(providerReference) });
  }
}

function tokenDigest(value: string): string { return createHash("sha256").update(value, "utf8").digest("base64url"); }
function expired(value: string, now = new Date()): boolean { return Date.parse(value) <= now.getTime(); }
function verifyOrder(order: Awaited<ReturnType<PayPalSandboxOrdersAdapter["getOrder"]>>, orderId: string, correlationId: string, amount: CurrencyAmount, merchantId: string | undefined, expectedStatus: string): void {
  const unit = order.purchase_units?.[0];
  if (order.id !== orderId || order.status !== expectedStatus || !unit || unit.custom_id !== correlationId || unit.amount?.currency_code !== amount.currency || unit.amount.value !== amount.value || (merchantId && unit.payee?.merchant_id !== merchantId)) throw new Error("PAYPAL_ORDER_VERIFICATION_MISMATCH");
}
function verifyEvidence(evidence: StoredPaymentEvidence["evidence"], orderId: string, correlationId: string, amount: CurrencyAmount, merchantId: string | undefined): void {
  if (evidence.isSynthetic || evidence.status !== "COMPLETED" || !evidence.captureId || evidence.resourceId !== orderId || evidence.correlationId !== correlationId || evidence.amount.currency !== amount.currency || evidence.amount.value !== amount.value || (merchantId && evidence.merchantId !== merchantId)) throw new Error("PAYPAL_CAPTURE_VERIFICATION_MISMATCH");
}
