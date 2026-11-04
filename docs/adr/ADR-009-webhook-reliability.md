# ADR-009: Webhook Reliability

**Status:** Accepted. **Decision:** treat deliveries as untrusted, duplicate, delayed, replayable, and out of order; verify then retrieve independently. **Consequences:** an inbox/dedupe model is required in Stage 1, and synthetic events cannot establish real payment capture.
