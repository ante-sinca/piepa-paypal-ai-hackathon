import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedProviderAdapter, canTransition, loadStage0Config, transition } from "../src/index.js";

test("state machine prevents payment confirmation from becoming payout authorisation", () => {
  assert.equal(canTransition("PAYMENT_VERIFIED", "AUTHORISED"), false);
  assert.equal(transition("PAYMENT_VERIFIED", "ELIGIBILITY_PENDING"), "ELIGIBILITY_PENDING");
  assert.throws(() => transition("PAYMENT_VERIFIED", "AUTHORISED"));
});

test("provider placeholders are fail-closed and Stage 0 cannot enable live mode", async () => {
  const provider = new UnsupportedProviderAdapter("paypal-sandbox");
  const result = await provider.createPaymentResource({ correlationId: "corr-001", amount: { currency: "GBP", value: "10.00" } });
  assert.deepEqual(result.ok, false);
  assert.throws(() => loadStage0Config({ HBIEPA_OPERATION_MODE: "live" }));
});
