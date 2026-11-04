import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type { AuditEvent } from "../audit/contracts.js";
import type { EnvelopePayload, PaymentEvidence, PayoutAuthorisation, SignedEnvelope } from "../contracts/envelope.js";
import type { InstructionState } from "../domain/lifecycle.js";
import { canTransition } from "../domain/lifecycle.js";
import {
  emptyLedgerSnapshot, type EnvelopeVersionRecord, type InstructionRecord, type LedgerSnapshot, type MockExecutionAttempt,
  type PayPalOrderBinding, type PayPalOrderPaymentSession, type PayPalPaymentLinkBinding, type PolicyDecisionRecord, type ReconciliationRecord,
  type StoredPaymentEvidence, type WebhookRecord,
} from "./local-ledger.js";

const now = () => new Date().toISOString();
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("base64url");
const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/**
 * Stage 1A local ACID ledger. SQLite owns the transaction boundary and SQL
 * uniqueness guards; the versioned domain snapshot keeps the Stage 1 contract
 * stable while migrations can evolve independently.
 */
export class SqliteDurableLedger {
  private readonly db: DatabaseSync;

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath, { timeout: 10_000, defensive: true, enableForeignKeyConstraints: true });
    this.migrate();
  }

  close(): void { this.db.close(); }

  async snapshot(): Promise<Readonly<LedgerSnapshot>> { return this.readSnapshot(); }

  async createDraft(draft: EnvelopePayload): Promise<InstructionRecord> {
    return this.mutate((ledger) => {
      if (ledger.instructions.some((item) => item.envelopeId === draft.envelopeId)) throw new Error("Duplicate envelope ID");
      if (ledger.instructions.some((item) => item.draft.nonce === draft.nonce)) throw new Error("Duplicate envelope nonce");
      this.run("INSERT INTO instruction_guard(envelope_id, nonce) VALUES (?, ?)", draft.envelopeId, draft.nonce);
      const record: InstructionRecord = { envelopeId: draft.envelopeId, draft, state: "DRAFT", revision: 0, validationErrors: [], versions: [] };
      ledger.instructions.push(record);
      return record;
    });
  }

  async recordValidation(envelopeId: string, errors: readonly string[]): Promise<InstructionRecord> {
    return this.mutate((ledger) => {
      const record = this.requireInstruction(ledger, envelopeId);
      if (record.state !== "DRAFT") throw new Error("Only a draft can be validated");
      const updated = this.replaceInstruction(record, errors.length > 0
        ? { validationErrors: [...errors], state: "REJECTED", revision: record.revision + 1 }
        : { validationErrors: [], state: "VALIDATED", revision: record.revision + 1 });
      this.replaceIn(ledger.instructions, record, updated);
      return updated;
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
    return this.readSnapshot().instructions.find((item) => item.envelopeId === envelopeId);
  }

  async bindPayPalOrder(binding: PayPalOrderBinding): Promise<void> {
    await this.mutate((ledger) => {
      this.requireInstruction(ledger, binding.envelopeId);
      if (ledger.orderBindings.some((item) => item.envelopeId === binding.envelopeId || item.orderId === binding.orderId || item.correlationId === binding.correlationId)) throw new Error("Order, correlation ID, and envelope binding are all single-use");
      this.run("INSERT INTO order_binding_guard(envelope_id, order_id, correlation_id) VALUES (?, ?, ?)", binding.envelopeId, binding.orderId, binding.correlationId);
      ledger.orderBindings.push(binding);
    });
  }

  async getOrderBinding(envelopeId: string): Promise<PayPalOrderBinding | undefined> {
    return this.readSnapshot().orderBindings.find((item) => item.envelopeId === envelopeId);
  }

  async reservePayPalOrderPaymentSession(session: PayPalOrderPaymentSession): Promise<void> {
    await this.mutate((ledger) => {
      const instruction = this.requireInstruction(ledger, session.envelopeId);
      if (instruction.state !== "SIGNED") throw new Error("Payment session requires a signed instruction");
      if (session.status !== "PENDING_ORDER") throw new Error("New payment sessions must reserve before Order creation");
      if (ledger.orderPaymentSessions.some((item) => item.envelopeId === session.envelopeId || item.sessionTokenDigest === session.sessionTokenDigest || item.correlationId === session.correlationId)) throw new Error("Payment session envelope, token, and correlation are single-use");
      this.run("INSERT INTO order_payment_session_guard(envelope_id, token_digest, correlation_id) VALUES (?, ?, ?)", session.envelopeId, session.sessionTokenDigest, session.correlationId);
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
      if (ledger.paymentLinkBindings.some((item) => item.envelopeId === binding.envelopeId || item.paymentLinkId === binding.paymentLinkId)) throw new Error("Payment Link ID and envelope binding are single-use records");
      this.run("INSERT INTO payment_link_guard(envelope_id, payment_link_id) VALUES (?, ?)", binding.envelopeId, binding.paymentLinkId);
      ledger.paymentLinkBindings.push(binding);
    });
  }

  async storePaymentEvidence(envelopeId: string, evidence: PaymentEvidence, rawProviderResource: string): Promise<StoredPaymentEvidence> {
    return this.mutate((ledger) => {
      this.requireInstruction(ledger, envelopeId);
      const captureIdentity = evidence.captureId ?? evidence.resourceId;
      if (ledger.paymentEvidence.some((item) => item.envelopeId === envelopeId && (item.evidence.captureId ?? item.evidence.resourceId) === captureIdentity)) throw new Error("Duplicate capture evidence");
      this.run("INSERT INTO capture_guard(envelope_id, capture_identity) VALUES (?, ?)", envelopeId, captureIdentity);
      const stored: StoredPaymentEvidence = { evidenceId: randomUUID(), envelopeId, evidence, rawProviderDigest: digest(rawProviderResource) };
      ledger.paymentEvidence.push(stored);
      return stored;
    });
  }

  async recordWebhook(record: WebhookRecord): Promise<{ duplicate: boolean; record: WebhookRecord }> {
    try {
      return this.mutate((ledger) => {
        const found = ledger.webhooks.find((item) => item.deliveryId === record.deliveryId);
        if (found) return { duplicate: true, record: found };
        this.run("INSERT INTO webhook_delivery_guard(delivery_id) VALUES (?)", record.deliveryId);
        ledger.webhooks.push(record);
        return { duplicate: false, record };
      });
    } catch (error) {
      if (!this.isConstraint(error)) throw error;
      const existing = this.readSnapshot().webhooks.find((item) => item.deliveryId === record.deliveryId);
      if (!existing) throw error;
      return { duplicate: true, record: existing };
    }
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
      this.run("INSERT INTO policy_decision_guard(decision_id) VALUES (?)", decision.decisionId);
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
      this.run("INSERT INTO authorisation_guard(envelope_id, authorisation_id, execution_id) VALUES (?, ?, ?)", authorisation.envelopeId, authorisation.authorisationId, authorisation.executionId);
      ledger.authorisations.push(authorisation);
      this.replaceIn(ledger.instructions, instruction, this.replaceInstruction(instruction, { state: "AUTHORISED", revision: instruction.revision + 1 }));
      return authorisation;
    });
  }

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
      this.run("INSERT INTO execution_guard(authorisation_id, execution_id) VALUES (?, ?)", authorisationId, authorisation.executionId);
      this.replaceIn(ledger.authorisations, authorisation, { ...authorisation, state: "CONSUMED" });
      this.replaceIn(ledger.instructions, instruction, this.replaceInstruction(instruction, { state: "EXECUTION_PENDING", revision: instruction.revision + 1 }));
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
      if (instruction.state === "EXECUTION_PENDING" && canTransition(instruction.state, next)) this.replaceIn(ledger.instructions, instruction, this.replaceInstruction(instruction, { state: next, revision: instruction.revision + 1 }));
      return updated;
    });
  }

  async recordReconciliation(record: ReconciliationRecord): Promise<void> {
    await this.mutate((ledger) => { this.requireInstruction(ledger, record.envelopeId); ledger.reconciliations.push(record); });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.transaction(() => {
      this.run("INSERT INTO audit_events(event_id, occurred_at, envelope_id, payload) VALUES (?, ?, ?, ?)", event.eventId, event.occurredAt, event.envelopeId, JSON.stringify(event));
    });
  }

  /** Uses SQLite's online backup API. Existing target files are overwritten only by SQLite's documented backup operation. */
  async createBackup(backupPath: string): Promise<number> {
    await mkdir(dirname(backupPath), { recursive: true });
    return backup(this.db, backupPath, { rate: 100 });
  }

  /** Recovery is deliberately non-destructive: callers must choose a new database path. */
  static async restoreBackupToNewFile(backupPath: string, recoveryPath: string): Promise<void> {
    if (existsSync(recoveryPath)) throw new Error("Recovery target already exists; refusing destructive overwrite");
    await mkdir(dirname(recoveryPath), { recursive: true });
    await copyFile(backupPath, recoveryPath);
  }

  /** One-time import helper for a Stage 1 JSON ledger. It refuses to merge into a non-empty SQLite ledger. */
  async importLegacyJsonLedger(legacyPath: string): Promise<void> {
    const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as LedgerSnapshot;
    this.transaction(() => {
      const current = this.readSnapshot();
      if (current.instructions.length || current.auditEvents.length) throw new Error("SQLite ledger is not empty; legacy import is refused");
      this.writeSnapshot({ ...legacy, auditEvents: [] });
      for (const instruction of legacy.instructions) this.run("INSERT INTO instruction_guard(envelope_id, nonce) VALUES (?, ?)", instruction.envelopeId, instruction.draft.nonce);
      for (const binding of legacy.orderBindings) this.run("INSERT INTO order_binding_guard(envelope_id, order_id, correlation_id) VALUES (?, ?, ?)", binding.envelopeId, binding.orderId, binding.correlationId);
      for (const session of legacy.orderPaymentSessions ?? []) this.run("INSERT INTO order_payment_session_guard(envelope_id, token_digest, correlation_id) VALUES (?, ?, ?)", session.envelopeId, session.sessionTokenDigest, session.correlationId);
      for (const binding of legacy.paymentLinkBindings) this.run("INSERT INTO payment_link_guard(envelope_id, payment_link_id) VALUES (?, ?)", binding.envelopeId, binding.paymentLinkId);
      for (const item of legacy.paymentEvidence) this.run("INSERT INTO capture_guard(envelope_id, capture_identity) VALUES (?, ?)", item.envelopeId, item.evidence.captureId ?? item.evidence.resourceId);
      for (const item of legacy.webhooks) this.run("INSERT INTO webhook_delivery_guard(delivery_id) VALUES (?)", item.deliveryId);
      for (const item of legacy.policyDecisions) this.run("INSERT INTO policy_decision_guard(decision_id) VALUES (?)", item.decisionId);
      for (const item of legacy.authorisations) this.run("INSERT INTO authorisation_guard(envelope_id, authorisation_id, execution_id) VALUES (?, ?, ?)", item.envelopeId, item.authorisationId, item.executionId);
      for (const item of legacy.executionAttempts) this.run("INSERT INTO execution_guard(authorisation_id, execution_id) VALUES (?, ?)", item.authorisationId, item.executionId);
      for (const event of legacy.auditEvents) this.run("INSERT INTO audit_events(event_id, occurred_at, envelope_id, payload) VALUES (?, ?, ?, ?)", event.eventId, event.occurredAt, event.envelopeId, JSON.stringify(event));
    });
  }

  private migrate(): void {
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS ledger_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS instruction_guard(envelope_id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS order_binding_guard(envelope_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, correlation_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS order_payment_session_guard(envelope_id TEXT PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE, correlation_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS payment_link_guard(envelope_id TEXT PRIMARY KEY, payment_link_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS capture_guard(envelope_id TEXT NOT NULL, capture_identity TEXT NOT NULL, PRIMARY KEY(envelope_id, capture_identity)) STRICT;
      CREATE TABLE IF NOT EXISTS webhook_delivery_guard(delivery_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS policy_decision_guard(decision_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS authorisation_guard(envelope_id TEXT PRIMARY KEY, authorisation_id TEXT NOT NULL UNIQUE, execution_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS execution_guard(authorisation_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events(event_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, envelope_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS audit_events_immutable_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS audit_events_immutable_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
    `);
    const version = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (!version) this.run("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)", now());
    const state = this.db.prepare("SELECT payload FROM ledger_snapshot WHERE singleton = 1").get();
    if (!state) this.run("INSERT INTO ledger_snapshot(singleton, payload) VALUES (1, ?)", JSON.stringify({ ...emptyLedgerSnapshot(), auditEvents: [] }));
  }

  private mutate<T>(work: (ledger: LedgerSnapshot) => T): T {
    return this.transaction(() => {
      const ledger = this.readSnapshot();
      const result = work(ledger);
      this.writeSnapshot({ ...ledger, auditEvents: [] });
      return result;
    });
  }

  private transaction<T>(work: () => T): T {
    let started = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      started = true;
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (started) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      }
      throw error;
    }
  }

  private readSnapshot(): LedgerSnapshot {
    const row = this.db.prepare("SELECT payload FROM ledger_snapshot WHERE singleton = 1").get();
    if (!row || typeof row.payload !== "string") throw new Error("SQLite ledger snapshot is missing");
    const snapshot = JSON.parse(row.payload) as LedgerSnapshot;
    const auditEvents = this.db.prepare("SELECT payload FROM audit_events ORDER BY occurred_at, event_id").all()
      .map((auditRow) => JSON.parse(String(asRecord(auditRow).payload)) as AuditEvent);
    return { ...snapshot, orderPaymentSessions: snapshot.orderPaymentSessions ?? [], auditEvents };
  }

  private writeSnapshot(snapshot: LedgerSnapshot): void {
    this.run("UPDATE ledger_snapshot SET payload = ? WHERE singleton = 1", JSON.stringify(snapshot));
  }

  private run(sql: string, ...parameters: unknown[]): void { this.db.prepare(sql).run(...parameters); }
  private isConstraint(error: unknown): boolean { return error instanceof Error && /constraint|unique/i.test(error.message); }
  private requireInstruction(ledger: LedgerSnapshot, envelopeId: string): InstructionRecord {
    const record = ledger.instructions.find((item) => item.envelopeId === envelopeId);
    if (!record) throw new Error("Unknown envelope");
    return record;
  }
  private replaceInstruction(record: InstructionRecord, patch: Partial<InstructionRecord>): InstructionRecord { return { ...record, ...patch }; }
  private replaceIn<T>(items: T[], oldValue: T, newValue: T): void {
    const index = items.indexOf(oldValue);
    if (index < 0) throw new Error("Ledger corruption: record disappeared");
    items[index] = newValue;
  }
}
