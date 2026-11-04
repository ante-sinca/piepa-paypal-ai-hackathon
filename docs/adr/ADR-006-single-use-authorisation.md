# ADR-006: Single-Use Payout Authorisation

**Status:** Accepted. **Decision:** create a separate durable authorisation tied to one envelope, evidence, payout digest, expiry, and consumption record. **Consequences:** a transactionally enforced unique `envelope_id` constraint and atomic consume are mandatory; provider idempotency alone is insufficient.
