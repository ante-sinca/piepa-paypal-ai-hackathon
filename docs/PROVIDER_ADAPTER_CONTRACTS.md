# Provider Adapter Contracts

HBIEPA depends on five separable ports: payment collection, payment verification, payout eligibility, payout execution, and provider reconciliation. All methods return a discriminated `ProviderResult`; they distinguish unsupported, ineligible, and ambiguous results rather than converting uncertainty to success.

| Port | Responsibility | Stage 0 implementation | Future target |
| --- | --- | --- | --- |
| Collection | Create/associate collection resource | Fail-closed | PayPal sandbox Orders v2 |
| Verification | Independently retrieve provider resource/evidence | Fail-closed | PayPal capture/order retrieval |
| Eligibility | Determine provider/funding eligibility | Fail-closed | PayPal research only |
| Execution | Submit an authorised payout | Fail-closed | Mock Philippine simulator only in Stage 1 |
| Reconciliation | Obtain terminal/provider state | Fail-closed | PayPal/mock adapter |

The adapter must not receive an AI tool handle or a private signing key. It may receive only an already-authorised, expiring, one-time authorisation. An execution adapter must atomically claim that authorisation before any side effect and persist its idempotency/reference data before accepting a retry.

The Stage 0 `UnsupportedProviderAdapter` deliberately implements every port with no network dependency and an `UNSUPPORTED_OPERATION` outcome. It is a guardrail, not an incomplete live client. PayPal Payouts is a non-executable research target; a future HomeBound adapter is an interface only, without any integration.
