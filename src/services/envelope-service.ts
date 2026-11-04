import { randomUUID } from "node:crypto";
import type { EnvelopePayload, SignedEnvelope } from "../contracts/envelope.js";
import { signEnvelope, verifyEnvelope } from "../crypto/signer.js";
import type { Stage1Persistence } from "../persistence/contracts.js";
import { validateEnvelope, type ValidationResult } from "../policy/validator.js";

export type VerificationResult = Readonly<{
  valid: boolean;
  reasons: readonly string[];
  envelope?: SignedEnvelope;
}>;

/** Keeps drafting, validation, signing and verification explicitly separate. */
export class EnvelopeService {
  constructor(private readonly ledger: Stage1Persistence) {}

  async createUnsignedDraft(draft: EnvelopePayload): Promise<void> {
    await this.ledger.createDraft(draft);
    await this.audit(draft.envelopeId, "CREATE_UNSIGNED_DRAFT", "ALLOW");
  }

  async validateDraft(envelopeId: string, at = new Date()): Promise<ValidationResult> {
    const record = await this.ledger.getInstruction(envelopeId);
    if (!record) throw new Error("Unknown envelope");
    const result = validateEnvelope(record.draft, at);
    await this.ledger.recordValidation(envelopeId, result.errors);
    await this.audit(envelopeId, "VALIDATE_DRAFT", result.valid ? "ALLOW" : "DENY");
    return result;
  }

  async signValidatedDraft(envelopeId: string, privateKeyPem: string, keyId: string, at = new Date()): Promise<SignedEnvelope> {
    const record = await this.ledger.getInstruction(envelopeId);
    if (!record || record.state !== "VALIDATED") throw new Error("Envelope must be validated before signing");
    const signed = signEnvelope(record.draft, privateKeyPem, keyId);
    await this.ledger.storeSignedVersion(envelopeId, signed, at.toISOString());
    await this.audit(envelopeId, "SIGN_VALIDATED_ENVELOPE", "ALLOW", signed.signature.payloadDigest);
    return signed;
  }

  async verifySignedEnvelope(envelopeId: string, publicKeys: Readonly<Record<string, string>>, at = new Date()): Promise<VerificationResult> {
    const record = await this.ledger.getInstruction(envelopeId);
    const signed = record?.versions[0]?.envelope;
    const reasons: string[] = [];
    if (!record || !signed) reasons.push("SIGNED_ENVELOPE_NOT_FOUND");
    const publicKey = signed ? publicKeys[signed.signature.keyId] : undefined;
    if (signed && !publicKey) reasons.push("UNKNOWN_SIGNING_KEY");
    if (signed && publicKey && !verifyEnvelope(signed, publicKey)) reasons.push("SIGNATURE_OR_DIGEST_INVALID");
    if (signed) reasons.push(...validateEnvelope(signed.payload, at).errors);
    const valid = reasons.length === 0;
    await this.audit(envelopeId, "VERIFY_SIGNED_ENVELOPE", valid ? "ALLOW" : "DENY", signed?.signature.payloadDigest);
    return valid ? { valid, reasons, envelope: signed } : { valid, reasons };
  }

  async openPaymentCollection(envelopeId: string): Promise<void> {
    await this.ledger.advanceState(envelopeId, "SIGNED", "PAYMENT_PENDING");
    await this.audit(envelopeId, "OPEN_PAYMENT_COLLECTION", "ALLOW");
  }

  async markPaymentVerified(envelopeId: string): Promise<void> {
    await this.ledger.advanceState(envelopeId, "PAYMENT_PENDING", "PAYMENT_VERIFIED");
    await this.ledger.advanceState(envelopeId, "PAYMENT_VERIFIED", "ELIGIBILITY_PENDING");
    await this.audit(envelopeId, "PAYMENT_VERIFIED_TO_ELIGIBILITY_PENDING", "ALLOW");
  }

  private async audit(envelopeId: string, action: string, outcome: "ALLOW" | "DENY", evidenceDigest?: string): Promise<void> {
    await this.ledger.appendAudit({ eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId, actorType: "SYSTEM", action, outcome, correlationId: envelopeId, evidenceDigest });
  }
}
