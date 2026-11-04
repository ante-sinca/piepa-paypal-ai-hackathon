import { randomUUID } from "node:crypto";
import type { ReconciliationRecord } from "../persistence/local-ledger.js";
import type { Stage1Persistence } from "../persistence/contracts.js";

/** Reconciliation for labelled synthetic evidence only; genuine PayPal reconciliation remains unchanged. */
export async function reconcileSyntheticDemoEnvelope(ledger: Stage1Persistence, envelopeId: string): Promise<ReconciliationRecord> {
  const snapshot = await ledger.snapshot();
  const findings: string[] = [];
  const instruction = snapshot.instructions.find((item) => item.envelopeId === envelopeId);
  const evidence = snapshot.paymentEvidence.find((item) => item.envelopeId === envelopeId);
  const authorisation = snapshot.authorisations.find((item) => item.envelopeId === envelopeId);
  const execution = authorisation ? snapshot.executionAttempts.find((item) => item.authorisationId === authorisation.authorisationId) : undefined;
  if (!instruction?.versions[0]) findings.push("MISSING_SIGNED_ENVELOPE");
  if (!evidence || !evidence.evidence.isSynthetic || evidence.evidence.provider !== "synthetic-demo") findings.push("MISSING_SYNTHETIC_DEMO_EVIDENCE");
  if (evidence && evidence.evidence.correlationId !== envelopeId) findings.push("PAYMENT_BINDING_REJECTED");
  if (!authorisation) findings.push("MISSING_AUTHORISATION");
  if (!execution || execution.outcome !== "SUCCEEDED") findings.push("MOCK_EXECUTION_NOT_SUCCEEDED");
  if (snapshot.authorisations.filter((item) => item.envelopeId === envelopeId).length > 1) findings.push("DUPLICATE_AUTHORISATION");
  const status: ReconciliationRecord["status"] = findings.length ? "EXCEPTION" : "RECONCILED";
  const record: ReconciliationRecord = { reconciliationId: randomUUID(), envelopeId, status, findings, createdAt: new Date().toISOString() };
  await ledger.recordReconciliation(record);
  if (status === "RECONCILED") await ledger.advanceState(envelopeId, "EXECUTED", "RECONCILED");
  return record;
}
