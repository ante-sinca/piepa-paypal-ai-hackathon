import type { PaymentCollectionAdapter, PaymentVerificationAdapter, PayoutEligibilityAdapter, PayoutExecutionAdapter, ProviderReconciliationAdapter, ProviderResult } from "./contracts.js";
import type { CurrencyAmount, PaymentEvidence, PayoutAuthorisation } from "../contracts/envelope.js";

const unsupported = <T>(operation: string): ProviderResult<T> => ({
  ok: false,
  code: "UNSUPPORTED_OPERATION",
  reason: `Stage 0 forbids ${operation}; this adapter intentionally has no provider side effect.`,
});

/** A structural placeholder for future PayPal or HomeBound adapters. Never makes network calls. */
export class UnsupportedProviderAdapter implements PaymentCollectionAdapter, PaymentVerificationAdapter, PayoutEligibilityAdapter, PayoutExecutionAdapter, ProviderReconciliationAdapter {
  constructor(readonly provider: string) {}
  async createPaymentResource(_: Readonly<{ correlationId: string; amount: CurrencyAmount }>) { return unsupported<{ resourceId: string }>("payment resource creation"); }
  async retrieveVerifiedPayment(_: string) { return unsupported<PaymentEvidence>("payment verification"); }
  async assessEligibility(_: Readonly<{ authorisation: PayoutAuthorisation }>) { return unsupported<{ eligible: boolean }>("payout eligibility assessment"); }
  async execute(_: PayoutAuthorisation) { return unsupported<{ providerExecutionId: string }>("payout execution"); }
  async reconcile(_: string) { return unsupported<{ state: "RECONCILED" | "UNKNOWN" }>("provider reconciliation"); }
}
