# Threat Model

Scope: HBIEPA's instruction control plane, later sandbox binding, and a simulated payout. This is not a complete provider, legal, or enterprise security assessment. Severity and residual risk must be reassessed before every stage.

| Threat / attack path | Impact | Prevention | Detection | Proposed test |
| --- | --- | --- | --- | --- |
| Envelope forgery | Unauthorised instruction | Ed25519, trusted key set | Signature/digest audit failure | Forged signature rejected |
| Payload substitution after signing | Changed beneficiary/amount | Canonical digest + signature | Digest mismatch | Modify one field |
| Key compromise | Valid malicious envelopes | HSM/KMS, rotation/revocation, least privilege | Key-use anomaly/revocation list | Revoked key rejected |
| Replay of envelope | Repeated release attempt | nonce, expiry, durable state | Duplicate ID/nonce alert | Submit twice |
| Expired execution | Late payout | Check expiry on every transition | Expiry audit event | Clock-boundary test |
| Payment/envelope misbinding | Wrong payment releases payout | Opaque correlation and independent retrieval | Mismatch reconciliation | Swap resource IDs |
| Reusable link ambiguity/multiple payments | One link maps to excess releases | Per-payment binding, one-use authorisation | Cardinality violation | Two payments for one envelope |
| Webhook spoofing | Fake payment confirmation | Preserve bytes, signature/postback verification, retrieve resource | Failed verification alert | Invalid headers/signature |
| Duplicate/out-of-order webhook | Incorrect lifecycle | Delivery dedupe/inbox ordering | Duplicate event metrics | Repeat/reorder event |
| Concurrent authorisation race | Double authorisation | Serial transaction and unique envelope constraint | Unique-conflict audit | Parallel requests |
| Double payout execution | Financial loss | Atomic consume before side effect + provider idempotency | Duplicate reference reconciliation | Timeout/retry simulation |
| Misleading settlement status | Funds assumed usable | Explicit settlement/funding states | Missing bridge blocks decision | Completed capture no eligibility |
| Provider timeout/ambiguous completion | Repeated payment or loss | `EXCEPTION`, retrieval before retry | Timeout/unknown dashboard | Lost response test |
| AI prompt injection | Policy bypass or data leak | No authority/tools/secrets; schemas/approval | Audit AI actor events | Hostile draft test |
| AI credential escalation | Live-provider access | No secrets in agent context | Secret scanning/access logs | Attempt adapter call |
| Cross-tenant leakage | Privacy breach | Tenant scope, opaque IDs, access control | Access audit | Cross-tenant retrieval test |
| Sensitive data exposure | Privacy/security harm | Data minimisation, encryption, redaction | DLP/log review | Log fixture scan |
| Reconciliation gap | Unresolved obligation | Append-only evidence, exception queue | Ageing/variance reports | Missing terminal state |

Stage 0 tests cover signature substitution, expiry, illegal state transition, and unsupported adapters. The remaining tests are acceptance gates for later stages because no provider/persistence system exists yet.
