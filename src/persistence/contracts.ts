import type { PayoutAuthorisation, SignedEnvelope } from "../contracts/envelope.js";
import type { InstructionState } from "../domain/lifecycle.js";
import type { AuditEvent } from "../audit/contracts.js";
import type { EnvelopePayload, PaymentEvidence, SignedEnvelope as Stage1SignedEnvelope } from "../contracts/envelope.js";
import type {
  EnvelopeVersionRecord, InstructionRecord, LedgerSnapshot, MockExecutionAttempt, PayPalOrderBinding, PayPalOrderPaymentSession, PayPalPaymentLinkBinding,
  PolicyDecisionRecord, ReconciliationRecord, StoredPaymentEvidence, WebhookRecord,
} from "./local-ledger.js";

export type StoredInstruction = Readonly<{
  envelope: SignedEnvelope;
  state: InstructionState;
  revision: number;
}>;

export interface InstructionRepository {
  withinTransaction<T>(work: () => Promise<T>): Promise<T>;
  insertEnvelope(envelope: SignedEnvelope): Promise<void>;
  compareAndSetState(envelopeId: string, expected: InstructionState, next: InstructionState): Promise<boolean>;
  insertSingleUseAuthorisation(authorisation: PayoutAuthorisation): Promise<void>;
  consumeAuthorisation(authorisationId: string): Promise<boolean>;
}

/** Required database invariant: UNIQUE(envelope_id) on payout_authorisations. */
export const SINGLE_USE_AUTHORISATION_CONSTRAINT = "payout_authorisations_envelope_id_key";

/** The Stage 1 services depend on this port, not a particular local storage engine. */
export interface Stage1Persistence {
  snapshot(): Promise<Readonly<LedgerSnapshot>>;
  createDraft(draft: EnvelopePayload): Promise<InstructionRecord>;
  recordValidation(envelopeId: string, errors: readonly string[]): Promise<InstructionRecord>;
  storeSignedVersion(envelopeId: string, signed: Stage1SignedEnvelope, signedAt?: string): Promise<InstructionRecord>;
  advanceState(envelopeId: string, expected: InstructionState, next: InstructionState): Promise<InstructionRecord>;
  getInstruction(envelopeId: string): Promise<InstructionRecord | undefined>;
  bindPayPalOrder(binding: PayPalOrderBinding): Promise<void>;
  getOrderBinding(envelopeId: string): Promise<PayPalOrderBinding | undefined>;
  reservePayPalOrderPaymentSession(session: PayPalOrderPaymentSession): Promise<void>;
  activatePayPalOrderPaymentSession(envelopeId: string, correlationId: string, orderId: string, approvalUrl: string): Promise<void>;
  refreshPayPalOrderExpectedMerchant(envelopeId: string, orderId: string, correlationId: string, expectedMerchantId: string): Promise<void>;
  bindPayPalPaymentLink(binding: PayPalPaymentLinkBinding): Promise<void>;
  storePaymentEvidence(envelopeId: string, evidence: PaymentEvidence, rawProviderResource: string): Promise<StoredPaymentEvidence>;
  recordWebhook(record: WebhookRecord): Promise<{ duplicate: boolean; record: WebhookRecord }>;
  updateWebhook(deliveryId: string, patch: Partial<Pick<WebhookRecord, "verification" | "processing" | "failureReason">>): Promise<WebhookRecord>;
  recordPolicyDecision(decision: PolicyDecisionRecord): Promise<void>;
  createAuthorisation(authorisation: PayoutAuthorisation, decisionId: string): Promise<PayoutAuthorisation>;
  beginMockExecution(authorisationId: string, attemptedAt?: string): Promise<{ attempt: MockExecutionAttempt; created: boolean }>;
  finishMockExecution(executionId: string, outcome: Exclude<MockExecutionAttempt["outcome"], "IN_PROGRESS">, completedAt?: string): Promise<MockExecutionAttempt>;
  recordReconciliation(record: ReconciliationRecord): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
}
