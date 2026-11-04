import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const authorisationFlag = "--authorise-one-replacement-gbp-1-00";
if (!process.argv.includes(authorisationFlag)) {
  console.error(`HBIEPA_REPLACEMENT_NOT_AUTHORISED: pass ${authorisationFlag} only after explicit operator authorisation.`);
  process.exitCode = 2;
} else {
  await retireUnavailableOrder();
}

async function retireUnavailableOrder() {
  const databasePath = resolve(process.cwd(), process.env.HBIEPA_SQLITE_PATH ?? ".hbiepa-data/hbiepa-stage1a.sqlite");
  const markerPath = join(dirname(databasePath), "s1a-act-1-first-order.json");
  if (!existsSync(markerPath)) fail("HBIEPA_ORDER_MARKER_MISSING: no active sandbox Order marker is available for retirement.");

  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (!marker || typeof marker.orderId !== "string" || typeof marker.envelopeId !== "string" || typeof marker.correlationId !== "string") {
    fail("HBIEPA_ORDER_MARKER_INVALID: refusing to retire an invalid local marker.");
  }

  const { SqliteDurableLedger } = await import("../dist/src/index.js");
  const ledger = new SqliteDurableLedger(databasePath);
  try {
    const instruction = await ledger.getInstruction(marker.envelopeId);
    if (!instruction) fail("HBIEPA_ORDER_RETIREMENT_INVALID: the active marker has no persisted envelope.");
    if (instruction.state === "PAYMENT_PENDING") await ledger.advanceState(marker.envelopeId, "PAYMENT_PENDING", "EXCEPTION");
    else if (instruction.state !== "EXCEPTION") fail(`HBIEPA_ORDER_RETIREMENT_INVALID: expected PAYMENT_PENDING or EXCEPTION, found ${instruction.state}.`);

    const snapshot = await ledger.snapshot();
    const alreadyAudited = snapshot.auditEvents.some((event) => event.envelopeId === marker.envelopeId && event.action === "RETIRE_UNAVAILABLE_PAYPAL_SANDBOX_ORDER");
    if (!alreadyAudited) {
      await ledger.appendAudit({
        eventId: randomUUID(), occurredAt: new Date().toISOString(), envelopeId: marker.envelopeId,
        actorType: "SYSTEM", action: "RETIRE_UNAVAILABLE_PAYPAL_SANDBOX_ORDER", outcome: "INFO",
        correlationId: marker.correlationId, evidenceDigest: sha256(`PAYPAL_SANDBOX_ORDER_404:${marker.orderId}`),
      });
    }

    const archiveDirectory = join(dirname(markerPath), "retired-orders");
    await mkdir(archiveDirectory, { recursive: true });
    const archivePath = join(archiveDirectory, `s1a-act-1-order-${sha256(marker.orderId).slice(0, 12)}-${Date.now()}.json`);
    await rename(markerPath, archivePath);
    console.log(`HBIEPA_SANDBOX_ORDER_RETIRED order_id_suffix=${suffix(marker.orderId)} archive_digest=${sha256(archivePath).slice(0, 12)}`);
  } finally {
    ledger.close();
  }
}

function sha256(value) { return createHash("sha256").update(value, "utf8").digest("base64url"); }
function suffix(value) { return value.slice(-8); }
function fail(message) { throw new Error(message); }
