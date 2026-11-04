# ADR-004: External PayPal Binding

**Status:** Accepted. **Decision:** store envelope independently and bind provider resources using an opaque correlation identifier. Orders v2 can be evaluated with `custom_id`; Payment Links/Buttons gets a separate Stage 1 correlation experiment. **Consequences:** raw signed envelopes are not put in payment metadata; undocumented link propagation stays unknown.
