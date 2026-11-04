/** A versioned, provider-neutral payment-to-payout instruction. */
export const ENVELOPE_VERSION = "1.0" as const;

export type CurrencyAmount = Readonly<{
  currency: string;
  value: string;
}>;

export type PaymentIntent = Readonly<{
  collectionPurpose: string;
  acceptedAmounts: Readonly<{ minimum: CurrencyAmount; maximum: CurrencyAmount }>;
  permittedPaymentProviders: readonly string[];
}>;

export type BeneficiaryConstraint = Readonly<{
  beneficiaryReference: string;
  destinationType: "PAYPAL_ACCOUNT" | "BANK_ACCOUNT" | "E_WALLET" | "MOCK";
  destinationReference: string;
  destinationCountry: string;
}>;

export type VerificationCondition =
  | "PAYMENT_RESOURCE_RETRIEVED"
  | "PAYMENT_AMOUNT_MATCHED"
  | "PAYMENT_CURRENCY_MATCHED"
  | "PAYMENT_PROVIDER_EVENT_VERIFIED"
  | "HUMAN_APPROVAL_RECORDED";

export type ExecutionConstraint = Readonly<{
  simulationOnly: true;
  payoutProvider: string;
  maxPayout: CurrencyAmount;
  oneTimeAuthorisationRequired: true;
}>;

export type EnvelopePayload = Readonly<{
  envelopeId: string;
  version: typeof ENVELOPE_VERSION;
  issuerId: string;
  authorisedPartyId: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
  paymentIntent: PaymentIntent;
  beneficiary: BeneficiaryConstraint;
  permittedActions: readonly ("COLLECT_PAYMENT" | "VERIFY_PAYMENT" | "AUTHORISE_SIMULATED_PAYOUT")[];
  requiredVerification: readonly VerificationCondition[];
  authorisationPolicyRef: string;
  execution: ExecutionConstraint;
  auditReference: string;
  reconciliationReference: string;
}>;

export type SignatureMetadata = Readonly<{
  algorithm: "Ed25519";
  keyId: string;
  payloadDigest: string;
  signature: string;
}>;

export type SignedEnvelope = Readonly<{
  payload: EnvelopePayload;
  signature: SignatureMetadata;
}>;

export type PaymentEvidence = Readonly<{
  provider: string;
  resourceId: string;
  captureId?: string;
  correlationId?: string;
  merchantId?: string;
  amount: CurrencyAmount;
  status: "COMPLETED" | "PENDING" | "DECLINED" | "UNKNOWN";
  independentlyRetrievedAt: string;
  verifiedProviderEventId?: string;
  isSynthetic: boolean;
}>;

export type PayoutAuthorisation = Readonly<{
  authorisationId: string;
  envelopeId: string;
  envelopeVersion: string;
  envelopeDigest: string;
  paymentEvidenceId: string;
  beneficiaryReference: string;
  payoutAmount: CurrencyAmount;
  payoutProvider: "mock-philippines";
  payoutIntentDigest: string;
  createdAt: string;
  expiresAt: string;
  executionId: string;
  state: "AUTHORISED" | "CONSUMED" | "EXPIRED" | "REJECTED";
}>;
