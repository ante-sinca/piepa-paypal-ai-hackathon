import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditEvent } from "../audit/contracts.js";
import type { EnvelopePayload, PaymentEvidence, PayoutAuthorisation, SignedEnvelope } from "../contracts/envelope.js";
import type { InstructionState } from "../domain/lifecycle.js";
import { canTransition } from "../domain/lifecycle.js";

export type EnvelopeVersionRecord = Readonly<{
  version: string;
  digest: string;
  signedAt: string;
  envelope: SignedEnvelope;
}>;

export type InstructionRecord = Readonly<{
  envelopeId: string;
  draft: EnvelopePayload;
  state: InstructionState;
  revision: number;
  validationErrors: readonly string[];
  versions: readonly EnvelopeVersionRecord[];
}>;

export type PayPalOrderBinding = Readonly<{
  envelopeId: string;
  orderId: string;
  correlationId: string;
  expectedAmount: { currency: string; value: string };
  expectedMerchantId?: string;
  createdAt: string;
}>;

/** Opaque customer-session metadata. The URL token itself is never persisted. */
export type PayPalOrderPaymentSession = Readonly<{
  envelopeId: string;
  sessionTokenDigest: string;
  correlationId: string;
  createRequestId: string;
  expectedAmount: { currency: string; value: string };
  expectedMerchantId?: string;
  applicationClientIdFingerprint?: string;
  expiresAt: string;
  createdAt: string;
  status: "PENDING_ORDER" | "READY";
  orderId?: string;
  approvalUrl?: string;
}>;

export type PayPalPaymentLinkBinding = Readonly<{
  envelopeId: string;
  paymentLinkId: string;
  paymentLinkUrl?: string;
  expectedAmount?: { currency: string; value: string };
  expectedMerchantId?: string;
  resourceStatus?: string;
  correlationStatus?: "PAYMENT_LINK_BINDING_UNPROVEN" | "PAYMENT_LINK_BINDING_VERIFIED";
  createdAt: string;
}>;

export type StoredPaymentEvidence = Readonly<{
  evidenceId: string;
  envelopeId: string;
  evidence: PaymentEvidence;
  rawProviderDigest: string;
}>;

export type WebhookSource = "PAYPAL_SANDBOX" | "PAYPAL_SIMULATOR" | "LOCAL_FIXTURE";
export type WebhookRecord = Readonly<{
  deliveryId: string;
  source: WebhookSource;
  rawBody: string;
  rawDigest: string;
  headers: Readonly<Record<string, string>>;
  receivedAt: string;
  verification: "PENDING" | "VERIFIED" | "REJECTED" | "SYNTHETIC";
  processing: "RECEIVED" | "DUPLICATE" | "WAITING_FOR_RESOURCE" | "RECONCILED" | "FAILED";
  failureReason?: string;
}>;

export type PolicyDecisionRecord = Readonly<{
  decisionId: string;
  envelopeId: string;
  paymentEvidenceId: string;
  outcome: "ALLOW_SIMULATION" | "DENY";
  reasons: readonly string[];
  createdAt: string;
}>;

export type MockExecutionAttempt = Readonly<{
  executionId: string;
  authorisationId: string;
  provider: "mock-philippines";
  outcome: "SUCCEEDED" | "FAILED" | "REJECTED" | "TIMEOUT" | "AMBIGUOUS" | "RETURNED" | "IN_PROGRESS";
  providerReference: string;
  attemptedAt: string;
  completedAt?: string;
}>;

export type ReconciliationRecord = Readonly<{
  reconciliationId: string;
  envelopeId: string;
  status: "RECONCILED" | "EXCEPTION" | "MISSING_EVIDENCE";
  findings: readonly string[];
  createdAt: string;
}>;

export type LedgerSnapshot = {
  schemaVersion: 1;
  instructions: InstructionRecord[];
  orderBindings: PayPalOrderBinding[];
  orderPaymentSessions: PayPalOrderPaymentSession[];
  paymentLinkBindings: PayPalPaymentLinkBinding[];
  paymentEvidence: StoredPaymentEvidence[];
  webhooks: WebhookRecord[];
  policyDecisions: PolicyDecisionRecord[];
  authorisations: PayoutAuthorisation[];
  executionAttempts: MockExecutionAttempt[];
  reconciliations: ReconciliationRecord[];
  auditEvents: AuditEvent[];
};

export const emptyLedgerSnapshot = (): LedgerSnapshot => ({
  schemaVersion: 1,
  instructions: [], orderBindings: [], orderPaymentSessions: [], paymentLinkBindings: [], paymentEvidence: [], webhooks: [], policyDecisions: [],
  authorisations: [], executionAttempts: [], reconciliations: [], auditEvents: [],
});

const now = () => new Date().toISOString();
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("base64url");

/**
 * Development-only durable repository. Every mutation obtains a filesystem
 * directory lock, reloads the ledger, checks invariants, then atomically
 * renames a fully written replacement. It intentionally has no HomeBound or
 * cloud database dependency. A production deployment needs a transactional DB.
 */
export class LocalDurableLedger {
  private readonly lockPath: string;

  constructor(readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  async snapshot(): Promise<Readonly<LedgerSnapshot>> {
    return this.read();
  }

  async createDraft(draft: EnvelopePayload): Promise<InstructionRecord> {
    return this.mutate((ledger) => {
      if (ledger.instructions.some((item) => item.envelopeId === draft.envelopeId)) throw new Error("Duplicate envelope ID");
      if (ledger.instructions.some((item) => item.draft.nonce === draft.nonce)) throw new Error("Duplicate envelope nonce");
      const record: InstructionRecord = { envelopeId: draft.envelopeId, draft, state: "DRAFT", revision: 0, validationErrors: [], versions: [] };
      ledger.instructions.push(record);
      return record;
    });
  }

  async recordValidation(envelopeId: string, errors: readonly string[]): Promise<InstructionRecord> {
    return this.mutate((ledger) => {
      const record = this.requireInstruction(ledger, envelopeId);
      if (record.state !== "DRAFT") throw new Error("Only a draft can be validated");
      if (errors.length > 0) {
        const rejected = this.replaceInstruction(record, { validationErrors: [...errors], state: "REJECTED", revision: record.revision + 1 });
        this.replaceIn(ledger.instructions, record, rejected);
        return rejected;
      }
      const validated = this.replaceInstruction(record, { validationErrors: [], state: "VALIDATED", revision: record.revision + 1 });
      this.replaceIn(ledger.instructions, record, validated);
      return validated;
    });
  }

  async storeSignedVersion(envelopeId: string, signed: SignedEnvelope, signedAt = now()): Promise<InstructionRecord> {
    return this.mutate((ledger) => {
      const record = this.requireInstruction(ledger, envelopeId);
      if (record.state !== "VALIDATED") throw new Error("Only a validated envelope can be signed");
      if (signed.payload.envelopeId !== envelopeId) throw new Error("Signed payload has the wrong envelope ID");
      if (record.versions.length > 0) throw new Error("Envelope version is immutable and already signed");
      const version: EnvelopeVersionRecord = { version: signed.payload.version, digest: signed.signature.payloadDigest, signedAt, envelope: signed };
      const updated = this.replaceInstruction(record, { versions: [version], state: "SIGNED", revision: record.revision + 1 });
      this.replaceIn(ledger.instructions, record, updated);
      return updated;
    });
  }

  async advanceState(envelopeId: string, expected: InstructionState, next: InstructionState): Promise<InstructionRecord> {
    return this.mutate((ledger) => {
      const record = this.requireInstruction(ledger, envelopeId);
      if (record.state !== expected) throw new Error(`State conflict: expected ${expected}, found ${record.state}`);
      if (!canTransition(expected, next)) throw new Error(`Illegal state transition: ${expected} -> ${next}`);
      const updated = this.replaceInstruction(record, { state: next, revision: record.revision + 1 });
      this.replaceIn(ledger.instructions, record, updated);
      return updated;
    });
  }

  async getInstruction(envelopeId: string): Promise<InstructionRecord | undefined> {
    return (await this.read()).instructions.find((item) => item.envelopeId === envelopeId);
  }

  async bindPayPalOrder(binding: PayPalOrderBinding): Promise<void> {
    await this.mutate((ledger) => {
      this.requireInstruction(ledger, binding.envelopeId);
      if (ledger.orderBindings.some((item) => item.envelopeId === binding.envelopeId || item.orderId === binding.orderId || item.correlationId === binding.correlationId)) {
        throw new Error("Order, correlation ID, and envelope binding are all single-use");
      }
      ledger.orderBindings.push(binding);
    });
  }

  async getOrderBinding(envelopeId: string): Promise<PayPalOrderBinding | undefined> {
    return (await this.read()).orderBindings.find((item) => item.envelopeId === envelopeId);
  }

  async reservePayPalOrderPaymentSession(session: PayPalOrderPaymentSession): Promise<void> {
    await this.mutate((ledger) => {
      const instruction = this.requireInstruction(ledger, session.envelopeId);
      if (instruction.state !== "SIGNED") throw new Error("Payment session requires a signed instruction");
      if (session.status !== "PENDING_ORDER") throw new Error("New payment sessions must reserve before Order creation");
      if (ledger.orderPaymentSessions.some((item) => item.envelopeId === session.envelopeId || item.sessionTokenDigest === session.sessionTokenDigest || item.correlationId === session.correlationId)) throw new Error("Payment session envelope, token, and correlation are single-use");
      ledger.orderPaymentSessions.push(session);
    });
  }

  async activatePayPalOrderPaymentSession(envelopeId: string, correlationId: string, orderId: string, approvalUrl: string): Promise<void> {
    await this.mutate((ledger) => {
      const session = ledger.orderPaymentSessions.find((item) => item.envelopeId === envelopeId);
      if (!session || session.correlationId !== correlationId || session.status !== "PENDING_ORDER") throw new Error("Payment session identity cannot be changed");
      if (!ledger.orderBindings.some((item) => item.envelopeId === envelopeId && item.orderId === orderId && item.correlationId === correlationId)) throw new Error("Payment session requires a matching persisted Order binding");
      this.replaceIn(ledger.orderPaymentSessions, session, { ...session, status: "READY", orderId, approvalUrl });
    });
  }

  /** Corrects only expected merchant metadata after independently verified provider evidence; identity fields remain immutable. */
  async refreshPayPalOrderExpectedMerchant(envelopeId: string, orderId: string, correlationId: string, expectedMerchantId: string): Promise<void> {
    await this.mutate((ledger) => {
      const binding = ledger.orderBindings.find((item) => item.envelopeId === envelopeId);
      if (!binding || binding.orderId !== orderId || binding.correlationId !== correlationId) throw new Error("Order binding identity cannot be changed");
      this.replaceIn(ledger.orderBindings, binding, { ...binding, expectedMerchantId });
    });
  }

  async bindPayPalPaymentLink(binding: PayPalPaymentLinkBinding): Promise<void> {
    await this.mutate((ledger) => {
      this.requireInstruction(ledger, binding.envelopeId);
      if (ledger.paymentLinkBindings.some((item) => item.envelopeId === binding.envelopeId || item.paymentLinkId === binding.paymentLinkId)) {
        throw new Error("Payment Link ID and envelope binding are single-use records");
      }
      ledger.paymentLinkBindings.push(binding);
    });
  }

  async storePaymentEvidence(envelopeId: string, evidence: PaymentEvidence, rawProviderResource: string): Promise<StoredPaymentEvidence> {
    return this.mutate((ledger) => {
      this.requireInstruction(ledger, envelopeId);
      if (ledger.paymentEvidence.some((item) => item.envelopeId === envelopeId && item.evidence.captureId === evidence.captureId)) {
        throw new Error("Duplicate capture evidence");
      }
      const value: StoredPaymentEvidence = { evidenceId: randomUUID(), envelopeId, evidence, rawProviderDigest: digest(rawProviderResource) };
      ledger.paymentEvidence.push(value);
      return value;
    });
  }

  async recordWebhook(record: WebhookRecord): Promise<{ duplicate: boolean; record: WebhookRecord }> {
    return this.mutate((ledger) => {
      const found = ledger.webhooks.find((item) => item.deliveryId === record.deliveryId);
      if (found) return { duplicate: true, record: found };
      ledger.webhooks.push(record);
      return { duplicate: false, record };
    });
  }

  async updateWebhook(deliveryId: string, patch: Partial<Pick<WebhookRecord, "verification" | "processing" | "failureReason">>): Promise<WebhookRecord> {
    return this.mutate((ledger) => {
      const existing = ledger.webhooks.find((item) => item.deliveryId === deliveryId);
      if (!existing) throw new Error("Unknown webhook delivery");
      const updated: WebhookRecord = { ...existing, ...patch };
      this.replaceIn(ledger.webhooks, existing, updated);
      return updated;
    });
  }

  async recordPolicyDecision(decision: PolicyDecisionRecord): Promise<void> {
    await this.mutate((ledger) => {
      this.requireInstruction(ledger, decision.envelopeId);
      if (!ledger.paymentEvidence.some((item) => item.evidenceId === decision.paymentEvidenceId)) throw new Error("Policy decision requires stored payment evidence");
      ledger.policyDecisions.push(decision);
    });
  }

  async createAuthorisation(authorisation: PayoutAuthorisation, decisionId: string): Promise<PayoutAuthorisation> {
    return this.mutate((ledger) => {
      const instruction = this.requireInstruction(ledger, authorisation.envelopeId);
      if (instruction.state !== "ELIGIBILITY_PENDING") throw new Error("Authorisation requires eligibility-pending state");
      const decision = ledger.policyDecisions.find((item) => item.decisionId === decisionId);
      if (!decision || decision.outcome !== "ALLOW_SIMULATION" || decision.envelopeId !== authorisation.envelopeId) throw new Error("A matching allow-simulation decision is required");
      if (ledger.authorisations.some((item) => item.envelopeId === authorisation.envelopeId)) throw new Error("Unique envelope authorisation constraint violated");
      if (ledger.authorisations.some((item) => item.authorisationId === authorisation.authorisationId || item.executionId === authorisation.executionId)) throw new Error("Duplicate authorisation or execution ID");
      ledger.authorisations.push(authorisation);
      const authorised = this.replaceInstruction(instruction, { state: "AUTHORISED", revision: instruction.revision + 1 });
      this.replaceIn(ledger.instructions, instruction, authorised);
      return authorisation;
    });
  }

  /** Atomically consumes the decision and reserves its stable execution identity. */
  async beginMockExecution(authorisationId: string, attemptedAt = now()): Promise<{ attempt: MockExecutionAttempt; created: boolean }> {
    return this.mutate((ledger) => {
      const previous = ledger.executionAttempts.find((item) => item.authorisationId === authorisationId);
      if (previous) return { attempt: previous, created: false };
      const authorisation = ledger.authorisations.find((item) => item.authorisationId === authorisationId);
      if (!authorisation) throw new Error("Unknown authorisation");
      if (authorisation.expiresAt <= attemptedAt) throw new Error("Authorisation is expired");
      if (authorisation.state !== "AUTHORISED") throw new Error("Authorisation was already consumed or rejected");
      const instruction = this.requireInstruction(ledger, authorisation.envelopeId);
      if (instruction.state !== "AUTHORISED") throw new Error("Instruction state does not permit execution");
      const consumed: PayoutAuthorisation = { ...authorisation, state: "CONSUMED" };
      this.replaceIn(ledger.authorisations, authorisation, consumed);
      const pending = this.replaceInstruction(instruction, { state: "EXECUTION_PENDING", revision: instruction.revision + 1 });
      this.replaceIn(ledger.instructions, instruction, pending);
      const attempt: MockExecutionAttempt = { executionId: authorisation.executionId, authorisationId, provider: "mock-philippines", outcome: "IN_PROGRESS", providerReference: `mock-${authorisation.executionId}`, attemptedAt };
      ledger.executionAttempts.push(attempt);
      return { attempt, created: true };
    });
  }

  async finishMockExecution(executionId: string, outcome: Exclude<MockExecutionAttempt["outcome"], "IN_PROGRESS">, completedAt = now()): Promise<MockExecutionAttempt> {
    return this.mutate((ledger) => {
      const attempt = ledger.executionAttempts.find((item) => item.executionId === executionId);
      if (!attempt) throw new Error("Unknown execution");
      if (attempt.outcome !== "IN_PROGRESS") return attempt;
      const updated: MockExecutionAttempt = { ...attempt, outcome, completedAt };
      this.replaceIn(ledger.executionAttempts, attempt, updated);
      const authorisation = ledger.authorisations.find((item) => item.authorisationId === attempt.authorisationId);
      if (!authorisation) throw new Error("Execution has no authorisation");
      const instruction = this.requireInstruction(ledger, authorisation.envelopeId);
      const next: InstructionState = outcome === "SUCCEEDED" ? "EXECUTED" : "EXCEPTION";
      if (instruction.state === "EXECUTION_PENDING" && canTransition(instruction.state, next)) {
        this.replaceIn(ledger.instructions, instruction, this.replaceInstruction(instruction, { state: next, revision: instruction.revision + 1 }));
      }
      return updated;
    });
  }

  async recordReconciliation(record: ReconciliationRecord): Promise<void> {
    await this.mutate((ledger) => {
      this.requireInstruction(ledger, record.envelopeId);
      ledger.reconciliations.push(record);
    });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.mutate((ledger) => { ledger.auditEvents.push(event); });
  }

  private async mutate<T>(work: (ledger: LedgerSnapshot) => T): Promise<T> {
    await this.acquireLock();
    try {
      const ledger = await this.read();
      const result = work(ledger);
      await this.write(ledger);
      return result;
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async read(): Promise<LedgerSnapshot> {
    try {
      const snapshot = JSON.parse(await readFile(this.filePath, "utf8")) as LedgerSnapshot;
      return { ...snapshot, orderPaymentSessions: snapshot.orderPaymentSessions ?? [] };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedgerSnapshot();
      throw error;
    }
  }

  private async write(ledger: LedgerSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
    // Windows can transiently reject replacement while an indexer or another
    // test worker has the target observed. Retrying preserves atomic rename;
    // falling back to an in-place write would weaken the durability guarantee.
    let lastError: unknown;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await rename(temporary, this.filePath);
        return;
      } catch (error: unknown) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 24) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError;
  }

  private async acquireLock(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await mkdir(this.lockPath);
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) throw new Error("Timed out acquiring local durable-ledger lock");
        await new Promise<void>((resolve) => setTimeout(resolve, 8));
      }
    }
  }

  private requireInstruction(ledger: LedgerSnapshot, envelopeId: string): InstructionRecord {
    const record = ledger.instructions.find((item) => item.envelopeId === envelopeId);
    if (!record) throw new Error("Unknown envelope");
    return record;
  }

  private replaceInstruction(record: InstructionRecord, patch: Partial<InstructionRecord>): InstructionRecord {
    return { ...record, ...patch };
  }

  private replaceIn<T>(items: T[], oldValue: T, newValue: T): void {
    const index = items.indexOf(oldValue);
    if (index < 0) throw new Error("Ledger corruption: record disappeared");
    items[index] = newValue;
  }
}
