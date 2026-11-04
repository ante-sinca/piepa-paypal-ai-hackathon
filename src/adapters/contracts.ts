import type { CurrencyAmount, PaymentEvidence, PayoutAuthorisation } from "../contracts/envelope.js";

export type ProviderResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: "UNSUPPORTED_OPERATION" | "NOT_ELIGIBLE" | "AMBIGUOUS"; reason: string }>;

export interface PaymentCollectionAdapter {
  readonly provider: string;
  createPaymentResource(input: Readonly<{ correlationId: string; amount: CurrencyAmount }>): Promise<ProviderResult<{ resourceId: string }>>;
}

export interface PaymentVerificationAdapter {
  readonly provider: string;
  retrieveVerifiedPayment(resourceId: string): Promise<ProviderResult<PaymentEvidence>>;
}

export interface PayoutEligibilityAdapter {
  readonly provider: string;
  assessEligibility(input: Readonly<{ authorisation: PayoutAuthorisation }>): Promise<ProviderResult<{ eligible: boolean }>>;
}

export interface PayoutExecutionAdapter {
  readonly provider: string;
  execute(authorisation: PayoutAuthorisation): Promise<ProviderResult<{ providerExecutionId: string }>>;
}

export interface ProviderReconciliationAdapter {
  readonly provider: string;
  reconcile(reference: string): Promise<ProviderResult<{ state: "RECONCILED" | "UNKNOWN" }>>;
}
