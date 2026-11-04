# Envelope Specification

## Format and canonical form

`EnvelopePayload` is JSON. The canonical bytes are a recursively lexicographically key-sorted JSON serialization, UTF-8 encoded. The `payloadDigest` is SHA-256 in base64url. The signature is Ed25519 over the canonical bytes and is base64url. The verifier recalculates the digest and then verifies the signature. The implementation rejects unsupported/NaN values; all monetary values are strings.

```json
{
  "envelopeId": "env-opaque-id",
  "version": "1.0",
  "issuerId": "merchant-id",
  "authorisedPartyId": "operator-id",
  "createdAt": "2026-10-22T10:00:00.000Z",
  "expiresAt": "2026-10-23T10:00:00.000Z",
  "nonce": "unique-replay-control",
  "paymentIntent": { "collectionPurpose": "...", "acceptedAmounts": { "minimum": { "currency": "GBP", "value": "10.00" }, "maximum": { "currency": "GBP", "value": "10.00" } }, "permittedPaymentProviders": ["paypal-sandbox"] },
  "beneficiary": { "beneficiaryReference": "opaque", "destinationType": "MOCK", "destinationReference": "opaque", "destinationCountry": "PH" },
  "permittedActions": ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
  "requiredVerification": ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "PAYMENT_PROVIDER_EVENT_VERIFIED", "HUMAN_APPROVAL_RECORDED"],
  "authorisationPolicyRef": "policy/version",
  "execution": { "simulationOnly": true, "payoutProvider": "mock-philippines", "maxPayout": { "currency": "PHP", "value": "700.00" }, "oneTimeAuthorisationRequired": true },
  "auditReference": "audit-ref",
  "reconciliationReference": "recon-ref"
}
```

`SignatureMetadata` adds `algorithm: Ed25519`, `keyId`, `payloadDigest`, and `signature`. The envelope has no secret. Do not embed beneficiary bank-account data in references; use a protected, separate vault in a future stage.

## Key lifecycle

Generate Ed25519 keys in a managed key service/HSM for non-test stages. Publish an active public-key set indexed by `keyId`; record signing time, activation, rotation, revocation, and verification evidence. Signatures remain verifiable with retired public keys. Private-key export, browser use, AI/tool access, logs, source control, and envelope inclusion are prohibited. Compromise revokes the key, blocks new authorisations, and triggers review of affected envelopes.

## Versioning and binding

The payload version is immutable. Any changed constraint is a new envelope ID/versioned record with a fresh approval/signature. PayPal binding stores `envelopeId` or a derived opaque correlation token locally and uses the provider's supported external identifier (Orders `custom_id` is a candidate); no raw signed envelope is put into a provider metadata field.
