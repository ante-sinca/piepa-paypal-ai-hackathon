import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, sha256Base64Url } from "../crypto/canonical-json.js";
import type { InstructionProposal, ProposalApproval, ProposalStoreSnapshot, StoredProposal } from "./contracts.js";
import { validateProposal } from "./validator.js";

const empty = (): ProposalStoreSnapshot => ({ proposals: [] });

/** Durable local proposal/approval record. It deliberately stores no signing key or provider credential. */
export class LocalProposalStore {
  constructor(private readonly filePath: string) {}
  async list(): Promise<readonly StoredProposal[]> { return (await this.read()).proposals; }
  async get(proposalId: string): Promise<StoredProposal | undefined> { return (await this.read()).proposals.find((item) => item.proposal.proposalId === proposalId); }
  async create(proposal: InstructionProposal): Promise<StoredProposal> {
    const validation = validateProposal(proposal);
    const stored: StoredProposal = { proposal, digest: sha256Base64Url(canonicalJson(proposal)), status: validation.valid ? "PENDING_HUMAN_APPROVAL" : "NEEDS_CLARIFICATION", validationErrors: validation.errors };
    await this.mutate((snapshot) => { if (snapshot.proposals.some((item) => item.proposal.proposalId === proposal.proposalId)) throw new Error("Duplicate proposal ID"); snapshot.proposals.push(stored); });
    return stored;
  }
  async approve(proposalId: string, operatorId: string, at = new Date()): Promise<StoredProposal> {
    return this.mutate((snapshot) => {
      const current = this.require(snapshot, proposalId); const validation = validateProposal(current.proposal, at);
      if (!validation.valid || current.status !== "PENDING_HUMAN_APPROVAL") throw new Error("Proposal is not pending valid human approval");
      const updated: StoredProposal = { ...current, status: "APPROVED", approval: { operatorId, proposalDigest: current.digest, approvedAt: at.toISOString() } };
      this.replace(snapshot, current, updated); return updated;
    });
  }
  async reject(proposalId: string, reason: string): Promise<StoredProposal> { return this.mutate((snapshot) => { const current = this.require(snapshot, proposalId); const updated: StoredProposal = { ...current, status: "REJECTED", rejectionReason: reason }; this.replace(snapshot, current, updated); return updated; }); }
  async amend(proposalId: string, proposal: InstructionProposal): Promise<StoredProposal> {
    const current = await this.get(proposalId); if (!current) throw new Error("Unknown proposal");
    if (current.status === "SIGNED") throw new Error("Signed proposal is immutable; create a new proposal");
    return this.create({ ...proposal, proposalId: `proposal-${randomUUID()}`, version: current.proposal.version + 1, provenance: "MANUALLY_EDITED" });
  }
  async markSigned(proposalId: string): Promise<StoredProposal> { return this.mutate((snapshot) => { const current = this.require(snapshot, proposalId); if (current.status !== "APPROVED" || !current.approval || current.approval.proposalDigest !== current.digest) throw new Error("Exact approved proposal digest is required before signing"); const updated: StoredProposal = { ...current, status: "SIGNED", signedEnvelopeId: current.proposal.envelope.envelopeId }; this.replace(snapshot, current, updated); return updated; }); }
  private async read(): Promise<ProposalStoreSnapshot> { try { return JSON.parse(await readFile(this.filePath, "utf8")) as ProposalStoreSnapshot; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; } }
  private async mutate<T>(work: (snapshot: { proposals: StoredProposal[] }) => T): Promise<T> {
    const snapshot = await this.read(); const mutable = { proposals: [...snapshot.proposals] }; const result = work(mutable);
    await mkdir(dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(mutable), { encoding: "utf8", mode: 0o600 });
    // Windows may briefly deny an atomic replacement while a scanner observes the file.
    let lastError: unknown;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try { await rename(temp, this.filePath); return result; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1))); }
    }
    // Some Windows sandboxed temporary directories deny rename even when the
    // destination does not yet exist. Retain the fully written temp source and
    // use a documented copy fallback only after all atomic attempts fail.
    try { await copyFile(temp, this.filePath); await rm(temp, { force: true }); return result; } catch { throw lastError; }
  }
  private require(snapshot: ProposalStoreSnapshot, proposalId: string): StoredProposal { const found = snapshot.proposals.find((item) => item.proposal.proposalId === proposalId); if (!found) throw new Error("Unknown proposal"); return found; }
  private replace(snapshot: { proposals: StoredProposal[] }, before: StoredProposal, after: StoredProposal): void { const index = snapshot.proposals.indexOf(before); if (index < 0) throw new Error("Proposal storage corruption"); snapshot.proposals[index] = after; }
}
