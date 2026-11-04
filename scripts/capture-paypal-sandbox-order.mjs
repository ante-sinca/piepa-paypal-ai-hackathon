import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sandboxOrigin = "https://api-m.sandbox.paypal.com";
const amount = { currency: "GBP", value: "1.00" };
const approvalFlag = "--buyer-approved";
const markerName = markerFilenameFromArguments();
const environment = await loadIgnoredEnvironment();

if (!process.argv.includes(approvalFlag)) {
  console.error(`HBIEPA_BUYER_APPROVAL_NOT_CONFIRMED: pass ${approvalFlag} only after the Personal sandbox buyer has approved the exact persisted Order.`);
  process.exitCode = 2;
} else if (!environment.PAYPAL_SANDBOX_CLIENT_ID || !environment.PAYPAL_SANDBOX_CLIENT_SECRET || !environment.PAYPAL_SANDBOX_MERCHANT_ID) {
  console.error("HBIEPA_SANDBOX_CONFIGURATION_MISSING: credentials and expected sandbox merchant ID are required; no network request was made.");
  process.exitCode = 2;
} else {
  await captureAndReconcile(environment);
}

async function captureAndReconcile(environment) {
  const { loadStage1Config, AuthorisationService, EnvelopeService, MockPhilippinesPayoutAdapter, PayPalSandboxOrdersAdapter, SqliteDurableLedger, reconcileEnvelope } = await import("../dist/src/index.js");
  loadStage1Config(environment);
  if (environment.PAYPAL_API_ORIGIN && environment.PAYPAL_API_ORIGIN !== sandboxOrigin) fail("HBIEPA_SANDBOX_CONFIGURATION_INVALID: only the exact sandbox origin is permitted; no network request was made.");

  const databasePath = resolve(process.cwd(), environment.HBIEPA_SQLITE_PATH ?? ".hbiepa-data/hbiepa-stage1a.sqlite");
  const markerPath = join(dirname(databasePath), markerName);
  const marker = await readMarker(markerPath);
  const ledger = new SqliteDurableLedger(databasePath);
  try {
    const instruction = await ledger.getInstruction(marker.envelopeId);
    if (!instruction || !instruction.versions[0]) fail("HBIEPA_SANDBOX_CAPTURE_STATE_INVALID: the active marker has no signed persisted envelope.");
    if (!marker.captureRequestId) {
      marker.captureRequestId = `hbiepa-s1a-capture-${randomUUID()}`;
      marker.updatedAt = new Date().toISOString();
      await writeMarker(markerPath, marker);
    }

    const paypal = new PayPalSandboxOrdersAdapter({ clientId: environment.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: environment.PAYPAL_SANDBOX_CLIENT_SECRET });
    const beforeCapture = await ledger.snapshot();
    const existingEvidence = beforeCapture.paymentEvidence.find((item) => item.envelopeId === marker.envelopeId && item.evidence.captureId);
    const approvedOrder = await paypal.getOrder(marker.orderId);
    verifyOrderForCapture(approvedOrder, marker, environment.PAYPAL_SANDBOX_MERCHANT_ID, Boolean(existingEvidence));

    if (!existingEvidence) await paypal.captureOrder(marker.orderId, marker.captureRequestId);

    const { evidence, rawOrder } = await paypal.retrieveCaptureEvidence(marker.orderId);
    verifyCaptureEvidence(evidence, marker, environment.PAYPAL_SANDBOX_MERCHANT_ID);
    const afterCapture = await ledger.snapshot();
    const storedEvidence = afterCapture.paymentEvidence.find((item) => item.envelopeId === marker.envelopeId && item.evidence.captureId === evidence.captureId)
      ?? await ledger.storePaymentEvidence(marker.envelopeId, evidence, rawOrder);
    const binding = (await ledger.snapshot()).orderBindings.find((item) => item.envelopeId === marker.envelopeId);
    if (!binding || binding.orderId !== marker.orderId || binding.correlationId !== marker.correlationId) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: persisted Order binding identity did not match the independently retrieved evidence.");
    if (binding.expectedMerchantId !== evidence.merchantId) {
      await ledger.refreshPayPalOrderExpectedMerchant(marker.envelopeId, marker.orderId, marker.correlationId, evidence.merchantId);
      await ledger.appendAudit({ eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId: marker.envelopeId, actorType: "SYSTEM", action: "REFRESH_PAYPAL_ORDER_EXPECTED_MERCHANT", outcome: "INFO", correlationId: marker.correlationId, evidenceDigest: sha256(`MERCHANT_REFRESH:${binding.expectedMerchantId ?? "missing"}:${evidence.merchantId}`) });
    }

    const afterEvidence = await ledger.getInstruction(marker.envelopeId);
    const envelopeService = new EnvelopeService(ledger);
    if (afterEvidence?.state === "PAYMENT_PENDING") await envelopeService.markPaymentVerified(marker.envelopeId);
    const signature = await envelopeService.verifySignedEnvelope(marker.envelopeId, { [marker.keyId]: marker.publicKey });
    if (!signature.valid) fail("HBIEPA_SANDBOX_CAPTURE_STATE_INVALID: signed envelope verification failed after capture.");

    const approvalAudit = (await ledger.snapshot()).auditEvents.some((event) => event.envelopeId === marker.envelopeId && event.action === "HUMAN_SANDBOX_BUYER_APPROVAL_CONFIRMED");
    if (!approvalAudit) {
      await ledger.appendAudit({ eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId: marker.envelopeId, actorType: "HUMAN", action: "HUMAN_SANDBOX_BUYER_APPROVAL_CONFIRMED", outcome: "INFO", correlationId: marker.correlationId, evidenceDigest: sha256(`BUYER_APPROVAL_CONFIRMED:${marker.orderId}`) });
    }

    const readySnapshot = await ledger.snapshot();
    let authorisation = readySnapshot.authorisations.find((item) => item.envelopeId === marker.envelopeId);
    if (!authorisation) {
      const expiry = new Date(Math.min(Date.parse(instruction.draft.expiresAt), Date.now() + 15 * 60 * 1000)).toISOString();
      const result = await new AuthorisationService(ledger).evaluateAndAuthorise({
        envelopeId: marker.envelopeId, publicKeyValid: true, humanApprovalRecorded: true, paymentEvidence: storedEvidence,
        intendedBeneficiaryReference: instruction.draft.beneficiary.beneficiaryReference,
        intendedPayout: instruction.draft.execution.maxPayout, providerEligibilityEvidence: true, expiresAt: expiry,
      });
      if (!result.authorisation) fail(`HBIEPA_SANDBOX_AUTHORISATION_DENIED: ${result.decision.reasons.join(",") || "policy denied"}.`);
      authorisation = result.authorisation;
    }

    const mock = await new MockPhilippinesPayoutAdapter(ledger).execute(authorisation, "SUCCEEDED");
    const postExecution = await ledger.snapshot();
    let reconciliation = postExecution.reconciliations.find((item) => item.envelopeId === marker.envelopeId && item.status === "RECONCILED");
    if (!reconciliation) reconciliation = await reconcileEnvelope(ledger, marker.envelopeId);
    if (reconciliation.status !== "RECONCILED") fail(`HBIEPA_SANDBOX_RECONCILIATION_EXCEPTION: ${reconciliation.findings.join(",") || "unknown finding"}.`);
    const finalInstruction = await ledger.getInstruction(marker.envelopeId);
    if (finalInstruction?.state === "EXECUTED") await ledger.advanceState(marker.envelopeId, "EXECUTED", "RECONCILED");

    console.log("HBIEPA_SANDBOX_CAPTURE_AND_RECONCILIATION_COMPLETE");
    console.log(`order_id_suffix=${suffix(marker.orderId)}`);
    console.log(`capture_id_suffix=${suffix(evidence.captureId)}`);
    console.log(`mock_execution_id_suffix=${suffix(mock.executionId)}`);
    console.log(`reconciliation_status=${reconciliation.status}`);
  } catch (error) {
    console.error(`HBIEPA_SANDBOX_CAPTURE_FAILED: ${sanitize(error)}`);
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}

async function loadIgnoredEnvironment() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  return parseDotEnv(await readFile(envPath, "utf8"));
}

async function readMarker(markerPath) {
  if (!existsSync(markerPath)) fail("HBIEPA_ORDER_MARKER_MISSING: no active replacement Order marker exists.");
  const value = JSON.parse(await readFile(markerPath, "utf8"));
  if (!value || typeof value.orderId !== "string" || typeof value.envelopeId !== "string" || typeof value.correlationId !== "string" || typeof value.publicKey !== "string" || typeof value.keyId !== "string") fail("HBIEPA_ORDER_MARKER_INVALID: refusing to use an invalid active marker.");
  return value;
}

async function writeMarker(markerPath, marker) {
  await mkdir(dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

function verifyOrderForCapture(order, marker, expectedMerchantId, captureAlreadyRecorded) {
  const unit = order.purchase_units?.[0];
  if (!order.id || order.id !== marker.orderId) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: retrieved Order ID did not match the active marker.");
  const expectedStatus = captureAlreadyRecorded ? "COMPLETED" : "APPROVED";
  if (order.status !== expectedStatus) fail(`HBIEPA_SANDBOX_BUYER_APPROVAL_NOT_VERIFIED: expected ${expectedStatus}, found ${order.status || "missing"}.`);
  if (!unit || unit.custom_id !== marker.correlationId) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: retrieved opaque correlation did not match.");
  if (unit.amount?.currency_code !== amount.currency || unit.amount?.value !== amount.value) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: retrieved amount or currency did not match GBP 1.00.");
  if (unit.payee?.merchant_id !== expectedMerchantId) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: retrieved merchant did not match the configured sandbox merchant.");
}

function verifyCaptureEvidence(evidence, marker, expectedMerchantId) {
  if (!evidence.captureId || evidence.status !== "COMPLETED") fail("HBIEPA_SANDBOX_CAPTURE_NOT_COMPLETED: independently retrieved evidence is not a completed capture.");
  if (evidence.resourceId !== marker.orderId || evidence.correlationId !== marker.correlationId) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: capture did not bind to the expected Order and envelope correlation.");
  if (evidence.amount.currency !== amount.currency || evidence.amount.value !== amount.value) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: capture amount or currency did not match GBP 1.00.");
  if (evidence.merchantId !== expectedMerchantId) fail("HBIEPA_SANDBOX_CAPTURE_MISMATCH: capture merchant did not match the configured sandbox merchant.");
}

function parseDotEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#"))
    .map((line) => { const separator = line.indexOf("="); return separator < 1 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]; })
    .filter((pair) => pair.length === 2));
}

function sha256(value) { return createHash("sha256").update(value, "utf8").digest("base64url"); }
function suffix(value) { return value ? value.slice(-8) : "missing"; }
function markerFilenameFromArguments() {
  const index = process.argv.indexOf("--marker");
  if (index < 0) return "s1a-act-1-first-order.json";
  const value = process.argv[index + 1];
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(value ?? "")) throw new Error("HBIEPA_ORDER_MARKER_INVALID: marker must be a simple .json filename.");
  return value;
}
function sanitize(error) {
  const message = error instanceof Error ? error.message : "unexpected error";
  return message.replace(/Bearer\s+\S+|Basic\s+\S+|[A-Za-z0-9_-]{24,}/g, "[redacted]");
}
function fail(message) { throw new Error(message); }
