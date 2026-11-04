import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const envPath = new URL("../.env", import.meta.url);
const environment = { ...process.env, ...(existsSync(envPath) ? parseDotEnv(await readFile(envPath, "utf8")) : {}) };
if (environment.HBIEPA_LOCAL_WEBHOOK_HOST && environment.HBIEPA_LOCAL_WEBHOOK_HOST !== "127.0.0.1") fail("HBIEPA_LOCAL_WEBHOOK_HOST must remain 127.0.0.1.");
const port = Number(environment.HBIEPA_LOCAL_WEBHOOK_PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("HBIEPA_LOCAL_WEBHOOK_PORT must be a valid local TCP port.");
const syntheticOnly = environment.HBIEPA_WEBHOOK_MODE !== "sandbox-verified";
if (!syntheticOnly && (!environment.PAYPAL_SANDBOX_CLIENT_ID || !environment.PAYPAL_SANDBOX_CLIENT_SECRET || !environment.PAYPAL_SANDBOX_WEBHOOK_ID)) fail("HBIEPA_SANDBOX_CONFIGURATION_MISSING: credentials and registered sandbox webhook ID are required unless HBIEPA_WEBHOOK_MODE=synthetic-only.");

const { loadStage1Config, PayPalSandboxOrdersAdapter, PayPalWebhookInbox, SqliteDurableLedger, createLocalSandboxWebhookReceiver, createSandboxOrderEvidenceRetriever } = await import("../dist/src/index.js");
loadStage1Config(environment);
const ledger = new SqliteDurableLedger(environment.HBIEPA_SQLITE_PATH ?? ".hbiepa-data/hbiepa-stage1a.sqlite");
const paypal = syntheticOnly ? undefined : new PayPalSandboxOrdersAdapter({ clientId: environment.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: environment.PAYPAL_SANDBOX_CLIENT_SECRET });
const inbox = new PayPalWebhookInbox(ledger, syntheticOnly ? undefined : environment.PAYPAL_SANDBOX_WEBHOOK_ID, paypal, paypal ? createSandboxOrderEvidenceRetriever({ ledger, paypal }) : undefined);
const receiver = createLocalSandboxWebhookReceiver({ inbox, callbackPath: environment.HBIEPA_LOCAL_WEBHOOK_PATH ?? "/webhooks/paypal/sandbox", source: syntheticOnly ? "LOCAL_FIXTURE" : "PAYPAL_SANDBOX" });
const callback = await receiver.start(port);
console.log(`HBIEPA_LOCAL_WEBHOOK_RECEIVER_READY ${callback}`);
console.log(syntheticOnly ? "HBIEPA_SYNTHETIC_WEBHOOK_MODE: all received events are labelled test-only and cannot establish payment evidence." : "HBIEPA_SANDBOX_WEBHOOK_VERIFICATION_ACTIVE: registered sandbox deliveries require signature verification and independent Order retrieval.");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await receiver.stop();
  ledger.close();
}
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });

function parseDotEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#"))
    .map((line) => { const separator = line.indexOf("="); return separator < 1 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]; })
    .filter((pair) => pair.length === 2));
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
