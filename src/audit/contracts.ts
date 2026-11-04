export type AuditEvent = Readonly<{
  eventId: string;
  occurredAt: string;
  envelopeId: string;
  actorType: "HUMAN" | "SYSTEM" | "AI" | "PROVIDER";
  action: string;
  outcome: "ALLOW" | "DENY" | "INFO";
  correlationId: string;
  evidenceDigest?: string;
}>;

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}
