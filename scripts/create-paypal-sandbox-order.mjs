import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sandboxOrigin = "https://api-m.sandbox.paypal.com";
const amount = { currency: "GBP", value: "1.00" };
const markerName = markerFilenameFromArguments();
const environment = await loadIgnoredEnvironment();

if (!environment.PAYPAL_SANDBOX_CLIENT_ID || !environment.PAYPAL_SANDBOX_CLIENT_SECRET || !environment.PAYPAL_SANDBOX_MERCHANT_ID) {
  console.error("HBIEPA_SANDBOX_CONFIGURATION_MISSING: configure the ignored .env with sandbox client credentials and the expected sandbox merchant ID; no network request was made.");
  process.exitCode = 2;
} else {
  await createSandboxOrder(environment);
}

async function createSandboxOrder(environment) {
const { loadStage1Config, EnvelopeService, PayPalSandboxOrdersAdapter, SqliteDurableLedger } = await import("../dist/src/index.js");
loadStage1Config(environment);
if (environment.PAYPAL_API_ORIGIN && environment.PAYPAL_API_ORIGIN !== sandboxOrigin) {
  console.error("HBIEPA_SANDBOX_CONFIGURATION_INVALID: only the exact sandbox origin is permitted; no network request was made.");
  process.exitCode = 2;
  return;
}

const databasePath = resolve(process.cwd(), environment.HBIEPA_SQLITE_PATH ?? ".hbiepa-data/hbiepa-stage1a.sqlite");
const markerPath = join(dirname(databasePath), markerName);
const ledger = new SqliteDurableLedger(databasePath);

try {
  let marker = await readMarker(markerPath);
  if (!marker) marker = await prepareEnvelopeAndMarker({ ledger, markerPath, EnvelopeService });

  const instruction = await ledger.getInstruction(marker.envelopeId);
  if (!instruction || instruction.state !== "PAYMENT_PENDING" || !instruction.versions[0]) {
    fail("HBIEPA_SANDBOX_ORDER_STATE_INVALID: the persisted activation envelope is not ready for collection; no network request was made.");
  }

  const paypal = new PayPalSandboxOrdersAdapter({ clientId: environment.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: environment.PAYPAL_SANDBOX_CLIENT_SECRET });
  if (!marker.orderId) {
    const created = await paypal.createOrder({
      correlationId: marker.correlationId,
      amount,
      returnUrl: environment.HBIEPA_SANDBOX_RETURN_URL ?? "https://example.com/hbiepa/sandbox-return",
      cancelUrl: environment.HBIEPA_SANDBOX_CANCEL_URL ?? "https://example.com/hbiepa/sandbox-cancel",
      requestId: marker.createRequestId,
    });
    marker = { ...marker, orderId: created.orderId, approvalUrl: created.approvalUrl, updatedAt: new Date().toISOString() };
    await writeMarker(markerPath, marker);
  }

  const binding = await ledger.getOrderBinding(marker.envelopeId);
  if (!binding) {
    await ledger.bindPayPalOrder({ envelopeId: marker.envelopeId, orderId: marker.orderId, correlationId: marker.correlationId, expectedAmount: amount, expectedMerchantId: environment.PAYPAL_SANDBOX_MERCHANT_ID, createdAt: marker.createdAt });
  } else if (binding.orderId !== marker.orderId || binding.correlationId !== marker.correlationId) {
    fail("HBIEPA_SANDBOX_ORDER_BINDING_CONFLICT: persisted order binding does not match the activation request.");
  }

  const retrieved = await paypal.getOrder(marker.orderId);
  verifyRetrievedOrder(retrieved, marker, environment.PAYPAL_SANDBOX_MERCHANT_ID);
  const evidenceDigest = sha256(JSON.stringify(retrieved));
  if (marker.orderEvidenceDigest !== evidenceDigest) {
    await ledger.appendAudit({ eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId: marker.envelopeId, actorType: "PROVIDER", action: "PAYPAL_SANDBOX_ORDER_RETRIEVED", outcome: "INFO", correlationId: marker.correlationId, evidenceDigest });
    marker = { ...marker, orderEvidenceDigest: evidenceDigest, updatedAt: new Date().toISOString() };
    await writeMarker(markerPath, marker);
  }

  if (!marker.approvalUrl) fail("HBIEPA_SANDBOX_ORDER_APPROVAL_URL_MISSING: the independently retrieved Order did not include an approval URL.");
  console.log("HBIEPA_SANDBOX_ORDER_READY");
  console.log(`order_id_suffix=${suffix(marker.orderId)}`);
  console.log(`envelope_id_suffix=${suffix(marker.envelopeId)}`);
  console.log(`order_status=${retrieved.status}`);
  console.log(`approval_url=${marker.approvalUrl}`);
  console.log("NEXT: approve this URL only with the PayPal Personal sandbox buyer. Do not treat the browser redirect as payment evidence. Return here only after approval is complete.");
} catch (error) {
  console.error(`HBIEPA_SANDBOX_ORDER_FAILED: ${sanitize(error)}`);
  process.exitCode = 1;
} finally {
  ledger.close();
}
}

async function prepareEnvelopeAndMarker({ ledger, markerPath, EnvelopeService }) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const envelopeId = `hbiepa-s1a-${randomUUID()}`;
  const correlationId = `hbiepa-s1a-${randomUUID()}`;
  const createRequestId = `hbiepa-s1a-order-${randomUUID()}`;
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = `ephemeral-sandbox-${randomUUID()}`;
  const envelope = {
    envelopeId, version: "1.0", issuerId: "hbiepa-sandbox-merchant", authorisedPartyId: "hbiepa-sandbox-operator", createdAt, expiresAt, nonce: randomUUID(),
    paymentIntent: { collectionPurpose: "HBIEPA S1A-ACT-1 sandbox verification", acceptedAmounts: { minimum: amount, maximum: amount }, permittedPaymentProviders: ["paypal-sandbox"] },
    beneficiary: { beneficiaryReference: "sandbox-mock-beneficiary", destinationType: "MOCK", destinationReference: "sandbox-mock-wallet", destinationCountry: "PH" },
    permittedActions: ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
    requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "PAYMENT_PROVIDER_EVENT_VERIFIED", "HUMAN_APPROVAL_RECORDED"],
    authorisationPolicyRef: "policy/s1a-act-1", execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency: "PHP", value: "50.00" }, oneTimeAuthorisationRequired: true }, auditReference: `audit-${envelopeId}`, reconciliationReference: `recon-${envelopeId}`,
  };
  const service = new EnvelopeService(ledger);
  await service.createUnsignedDraft(envelope);
  const validation = await service.validateDraft(envelopeId);
  if (!validation.valid) fail("HBIEPA_SANDBOX_ENVELOPE_INVALID: generated sandbox envelope did not validate.");
  await service.signValidatedDraft(envelopeId, privateKey, keyId);
  const verification = await service.verifySignedEnvelope(envelopeId, { [keyId]: publicKey });
  if (!verification.valid) fail("HBIEPA_SANDBOX_ENVELOPE_INVALID: generated sandbox envelope signature did not verify.");
  await service.openPaymentCollection(envelopeId);
  const marker = { version: 1, envelopeId, correlationId, createRequestId, publicKey, keyId, createdAt, expiresAt, updatedAt: createdAt };
  await writeMarker(markerPath, marker);
  return marker;
}

async function loadIgnoredEnvironment() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  return parseDotEnv(await readFile(envPath, "utf8"));
}

async function readMarker(markerPath) {
  if (!existsSync(markerPath)) return undefined;
  const value = JSON.parse(await readFile(markerPath, "utf8"));
  if (!value || value.version !== 1 || typeof value.envelopeId !== "string" || typeof value.correlationId !== "string" || typeof value.createRequestId !== "string" || typeof value.publicKey !== "string" || typeof value.createdAt !== "string") {
    fail("HBIEPA_SANDBOX_ORDER_MARKER_INVALID: refusing to use an invalid local activation marker.");
  }
  return value;
}

async function writeMarker(markerPath, marker) {
  await mkdir(dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

function verifyRetrievedOrder(order, marker, expectedMerchantId) {
  const unit = order.purchase_units?.[0];
  if (!order.id || order.id !== marker.orderId) fail("HBIEPA_SANDBOX_ORDER_RETRIEVAL_MISMATCH: retrieved order ID does not match the created order.");
  if (!new Set(["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"]).has(order.status)) {
    fail("HBIEPA_SANDBOX_ORDER_STATUS_INVALID: retrieved Order is not eligible for sandbox buyer approval.");
  }
  if (!unit || unit.custom_id !== marker.correlationId) fail("HBIEPA_SANDBOX_ORDER_RETRIEVAL_MISMATCH: opaque envelope correlation did not match.");
  if (unit.amount?.currency_code !== amount.currency || unit.amount?.value !== amount.value) fail("HBIEPA_SANDBOX_ORDER_RETRIEVAL_MISMATCH: retrieved amount or currency did not match GBP 1.00.");
  if (unit.payee?.merchant_id !== expectedMerchantId) {
    const received = unit.payee?.merchant_id ? suffix(unit.payee.merchant_id) : "absent";
    fail(`HBIEPA_SANDBOX_ORDER_RETRIEVAL_MISMATCH: retrieved merchant suffix=${received}; configured merchant suffix=${suffix(expectedMerchantId)}.`);
  }
}

function parseDotEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#"))
    .map((line) => { const separator = line.indexOf("="); return separator < 1 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]; })
    .filter((pair) => pair.length === 2));
}

function sha256(value) { return createHash("sha256").update(value, "utf8").digest("base64url"); }
function suffix(value) { return value.slice(-8); }
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
