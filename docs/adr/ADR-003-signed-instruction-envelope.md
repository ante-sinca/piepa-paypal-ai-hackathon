# ADR-003: Signed Instruction Envelope

**Status:** Accepted. **Decision:** sign a canonical versioned payload with Ed25519, publish a key ID and SHA-256 payload digest. **Rationale:** established public-key cryptography, compact signatures, and no proprietary scheme. **Consequences:** keys require lifecycle controls; altered data means a new version/approval/signature.
