# ADR-005: Deterministic State Machine

**Status:** Accepted. **Decision:** use explicit guarded transitions with terminal/restricted rejection, expiry, and exception states. **Consequences:** payment verification leads only to eligibility evaluation, never directly to payout authorisation; ambiguity fails closed.
