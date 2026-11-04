import { randomUUID } from "node:crypto";
import type { ReconciliationRecord } from "../persistence/local-ledger.js";
import type { Stage1Persistence } from "../persistence/contracts.js";

/** Joins instruction, independently retrieved capture and simulated execution without using AI source text. */
export async function reconcileEnvelope(ledger: Stage1Persistence, envelopeId: string): Promise<ReconciliationRecord> {
  const snapshot = await ledger.snapshot();
  const findings: string[] = [];
  const instruction = snapshot.instructions.find((item) => item.envelopeId === envelopeId);
  const binding = snapshot.orderBindings.find((item) => item.envelopeId === envelopeId);
  const evidence = snapshot.paymentEvidence.find((item) => item.envelopeId === envelopeId);
  const authorisation = snapshot.authorisations.find((item) => item.envelopeId === envelopeId);
  const execution = authorisation ? snapshot.executionAttempts.find((item) => item.authorisationId === authorisation.authorisationId) : undefined;
  if (!instruction?.versions[0]) findings.push("MISSING_SIGNED_ENVELOPE");
  if (!binding) findings.push("MISSING_PAYMENT_BINDING");
  if (!evidence || evidence.evidence.isSynthetic) findings.push("MISSING_INDEPENDENT_CAPTURE_EVIDENCE");
  if (binding && evidence && evidence.evidence.resourceId !== binding.orderId) findings.push("INCORRECT_PAYMENT_BINDING");
  if (binding && evidence && (binding.expectedAmount.currency !== evidence.evidence.amount.currency || binding.expectedAmount.value !== evidence.evidence.amount.value)) findings.push("AMOUNT_OR_CURRENCY_MISMATCH");
  if (!authorisation && execution) findings.push("UNAUTHORISED_EXECUTION");
  if (authorisation && snapshot.authorisations.filter((item) => item.envelopeId === envelopeId).length !== 1) findings.push("DUPLICATE_AUTHORISATION");
  if (!execution && authorisation?.state === "CONSUMED") findings.push("MISSING_PROVIDER_RESPONSE");
  if (execution?.outcome === "AMBIGUOUS" || execution?.outcome === "TIMEOUT" || execution?.outcome === "IN_PROGRESS") findings.push("AMBIGUOUS_EXECUTION_OUTCOME");
  if (execution?.outcome === "REJECTED" || execution?.outcome === "RETURNED" || execution?.outcome === "FAILED") findings.push("PROVIDER_REJECTION_OR_RETURN");
  if (instruction?.state === "RECONCILED" && findings.length > 0) findings.push("TERMINAL_STATE_INCONSISTENCY");
  const status: ReconciliationRecord["status"] = findings.some((item) => item.startsWith("MISSING_")) ? "MISSING_EVIDENCE" : findings.length > 0 ? "EXCEPTION" : "RECONCILED";
  const record: ReconciliationRecord = { reconciliationId: randomUUID(), envelopeId, status, findings, createdAt: new Date().toISOString() };
  await ledger.recordReconciliation(record);
  return record;
}
