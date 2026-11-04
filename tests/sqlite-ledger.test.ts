import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AuthorisationService, createLocalSandboxWebhookReceiver, EnvelopeService, LocalDurableLedger, PayPalWebhookInbox, SqliteDurableLedger,
  type EnvelopePayload,
} from "../src/index.js";

const created = "2099-11-01T10:00:00.000Z";
const expires = "2099-11-02T10:00:00.000Z";

function draft(id: string, nonce = `nonce-${id}`): EnvelopePayload {
  return {
    envelopeId: id, version: "1.0", issuerId: "merchant-stage1a", authorisedPartyId: "operator-stage1a", createdAt: created, expiresAt: expires, nonce,
    paymentIntent: { collectionPurpose: "SQLite durability test", acceptedAmounts: { minimum: { currency: "GBP", value: "1.00" }, maximum: { currency: "GBP", value: "1.00" } }, permittedPaymentProviders: ["paypal-sandbox"] },
    beneficiary: { beneficiaryReference: "beneficiary-stage1a", destinationType: "MOCK", destinationReference: "wallet-stage1a", destinationCountry: "PH" },
    permittedActions: ["COLLECT_PAYMENT", "VERIFY_PAYMENT", "AUTHORISE_SIMULATED_PAYOUT"],
    requiredVerification: ["PAYMENT_RESOURCE_RETRIEVED", "PAYMENT_AMOUNT_MATCHED", "PAYMENT_CURRENCY_MATCHED", "PAYMENT_PROVIDER_EVENT_VERIFIED", "HUMAN_APPROVAL_RECORDED"],
    authorisationPolicyRef: "policy/stage1a", execution: { simulationOnly: true, payoutProvider: "mock-philippines", maxPayout: { currency: "PHP", value: "50.00" }, oneTimeAuthorisationRequired: true }, auditReference: "audit-stage1a", reconciliationReference: "recon-stage1a",
  };
}

async function createEligibleLedger(filePath: string, id = "env-sqlite-001") {
  const ledger = new SqliteDurableLedger(filePath);
  const service = new EnvelopeService(ledger);
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  await service.createUnsignedDraft(draft(id));
  await service.validateDraft(id, new Date("2099-11-01T11:00:00.000Z"));
  await service.signValidatedDraft(id, privateKey, "sqlite-test-key", new Date("2099-11-01T11:00:00.000Z"));
  assert.equal((await service.verifySignedEnvelope(id, { "sqlite-test-key": publicKey }, new Date("2099-11-01T11:00:00.000Z"))).valid, true);
  await service.openPaymentCollection(id);
  await ledger.bindPayPalOrder({ envelopeId: id, orderId: `ORDER-${id}`, correlationId: `corr-${id}`, expectedAmount: { currency: "GBP", value: "1.00" }, createdAt: created });
  const evidence = await ledger.storePaymentEvidence(id, { provider: "paypal-sandbox", resourceId: `ORDER-${id}`, captureId: `CAP-${id}`, correlationId: `corr-${id}`, amount: { currency: "GBP", value: "1.00" }, status: "COMPLETED", independentlyRetrievedAt: created, isSynthetic: false }, "synthetic-independent-resource");
  await service.markPaymentVerified(id);
  return { ledger, evidence, id };
}

function runChild(code: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { output += String(data); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("SQLite ledger persists state across restart and rejects duplicate constraints transactionally", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".stage1a-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "ledger.sqlite");
  const { ledger, id } = await createEligibleLedger(filePath);
  await assert.rejects(ledger.createDraft(draft("env-sqlite-duplicate", `nonce-${id}`)), /Duplicate envelope nonce/);
  ledger.close();
  const reopened = new SqliteDurableLedger(filePath);
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.instructions[0].state, "ELIGIBILITY_PENDING");
  assert.equal(snapshot.orderBindings.length, 1);
  reopened.close();
});

test("SQLite backup/recovery and legacy JSON import are explicit and non-destructive", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".stage1a-sqlite-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyPath = join(directory, "legacy.json");
  const legacy = new LocalDurableLedger(legacyPath);
  await legacy.createDraft(draft("env-legacy-001"));
  const dbPath = join(directory, "imported.sqlite");
  const imported = new SqliteDurableLedger(dbPath);
  await imported.importLegacyJsonLedger(legacyPath);
  assert.equal((await imported.snapshot()).instructions[0].envelopeId, "env-legacy-001");
  const backupPath = join(directory, "ledger.backup.sqlite");
  await imported.createBackup(backupPath);
  imported.close();
  const recoveredPath = join(directory, "recovered.sqlite");
  await SqliteDurableLedger.restoreBackupToNewFile(backupPath, recoveredPath);
  const recovered = new SqliteDurableLedger(recoveredPath);
  assert.equal((await recovered.snapshot()).instructions.length, 1);
  recovered.close();
  await assert.rejects(SqliteDurableLedger.restoreBackupToNewFile(backupPath, recoveredPath), /refusing destructive overwrite/);
});

test("separate Node processes can create only one authorisation for one envelope", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".stage1a-sqlite-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "ledger.sqlite");
  const { ledger, evidence, id } = await createEligibleLedger(filePath, "env-process-001");
  ledger.close();
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const worker = `
    import { AuthorisationService, SqliteDurableLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = new SqliteDurableLedger(${JSON.stringify(filePath)});
    const snapshot = await ledger.snapshot();
    const evidence = snapshot.paymentEvidence.find((item) => item.evidenceId === ${JSON.stringify(evidence.evidenceId)});
    try {
      const result = await new AuthorisationService(ledger).evaluateAndAuthorise({
        envelopeId: ${JSON.stringify(id)}, publicKeyValid: true, humanApprovalRecorded: true, paymentEvidence: evidence,
        intendedBeneficiaryReference: "beneficiary-stage1a", intendedPayout: { currency: "PHP", value: "50.00" },
        providerEligibilityEvidence: true, expiresAt: ${JSON.stringify(expires)}, now: new Date("2099-11-01T11:00:00.000Z"),
      });
      console.log(result.authorisation ? "AUTHORISED" : "DENIED");
    } catch (error) { console.log("CONFLICT"); }
    ledger.close();
  `;
  const [left, right] = await Promise.all([runChild(worker), runChild(worker)]);
  assert.equal(left.code, 0, left.output);
  assert.equal(right.code, 0, right.output);
  assert.equal([left.output, right.output].filter((output) => output.includes("AUTHORISED")).length, 1);
  const verification = new SqliteDurableLedger(filePath);
  assert.equal((await verification.snapshot()).authorisations.length, 1);
  verification.close();
});

test("loopback webhook receiver binds only localhost and has the approved callback path", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".stage1a-sqlite-receiver-"));
  const ledger = new SqliteDurableLedger(join(directory, "ledger.sqlite"));
  const receiver = createLocalSandboxWebhookReceiver({ inbox: new PayPalWebhookInbox(ledger, undefined) });
  try {
    const callback = await receiver.start();
    assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/webhooks\/paypal\/sandbox$/);
  } finally {
    await receiver.stop();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
