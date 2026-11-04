import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const origin = "https://api-m.sandbox.paypal.com";
const callbackPath = "/webhooks/paypal/sandbox";
const requiredEvents = ["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED"];
const envPath = resolve(process.cwd(), ".env");
const operation = process.argv[2];

if (!existsSync(envPath)) fail("HBIEPA_SANDBOX_CONFIGURATION_MISSING: ignored .env is required.");
const environment = parseDotEnv(await readFile(envPath, "utf8"));
if (!environment.PAYPAL_SANDBOX_CLIENT_ID || !environment.PAYPAL_SANDBOX_CLIENT_SECRET) fail("HBIEPA_SANDBOX_CONFIGURATION_MISSING: sandbox client credentials are required.");

try {
  if (operation === "register") {
    const callbackUrl = process.argv[3];
    validateCallback(callbackUrl);
    if (environment.PAYPAL_SANDBOX_WEBHOOK_ID) fail("HBIEPA_WEBHOOK_ALREADY_CONFIGURED: remove the existing sandbox webhook before registering another.");
    const created = await api(environment, "/v1/notifications/webhooks", "POST", { url: callbackUrl, event_types: requiredEvents.map((name) => ({ name })) });
    if (!created || typeof created.id !== "string") fail("HBIEPA_WEBHOOK_REGISTRATION_FAILED: PayPal did not return a webhook ID.");
    const verified = await api(environment, `/v1/notifications/webhooks/${encodeURIComponent(created.id)}`, "GET");
    if (verified?.url !== callbackUrl || !Array.isArray(verified?.event_types) || !requiredEvents.every((name) => verified.event_types.some((event) => event?.name === name))) {
      fail("HBIEPA_WEBHOOK_REGISTRATION_MISMATCH: registered callback or required event set could not be confirmed.");
    }
    await updateEnvironment({ ...environment, PAYPAL_SANDBOX_WEBHOOK_ID: created.id, HBIEPA_WEBHOOK_MODE: "sandbox-verified" });
    console.log(`HBIEPA_SANDBOX_WEBHOOK_REGISTERED id_suffix=${suffix(created.id)} event_count=${requiredEvents.length}`);
  } else if (operation === "remove") {
    const webhookId = environment.PAYPAL_SANDBOX_WEBHOOK_ID;
    if (!webhookId) fail("HBIEPA_WEBHOOK_NOT_CONFIGURED: no sandbox webhook ID is available for removal.");
    const verified = await api(environment, `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, "GET");
    if (!verified || typeof verified.id !== "string" || verified.id !== webhookId) fail("HBIEPA_WEBHOOK_REMOVAL_MISMATCH: configured webhook ID could not be confirmed.");
    await api(environment, `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, "DELETE");
    await updateEnvironment({ ...environment, PAYPAL_SANDBOX_WEBHOOK_ID: "", HBIEPA_WEBHOOK_MODE: "synthetic-only" });
    console.log(`HBIEPA_SANDBOX_WEBHOOK_REMOVED id_suffix=${suffix(webhookId)}`);
  } else {
    fail("Usage: node scripts/manage-paypal-sandbox-webhook.mjs register <https callback> | remove");
  }
} catch (error) {
  console.error(`HBIEPA_SANDBOX_WEBHOOK_OPERATION_FAILED: ${sanitize(error)}`);
  process.exitCode = 1;
}

async function api(environment, path, method, body) {
  const tokenResponse = await fetch(`${origin}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${environment.PAYPAL_SANDBOX_CLIENT_ID}:${environment.PAYPAL_SANDBOX_CLIENT_SECRET}`, "utf8").toString("base64")}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tokenResponse.ok) fail(`HBIEPA_SANDBOX_OAUTH_FAILED: HTTP ${tokenResponse.status}`);
  const token = (await tokenResponse.json()).access_token;
  if (typeof token !== "string" || !token) fail("HBIEPA_SANDBOX_OAUTH_FAILED: access token was absent.");
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json", "PayPal-Request-Id": `hbiepa-webhook-${randomUUID()}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) fail(`HBIEPA_SANDBOX_WEBHOOK_API_FAILED: HTTP ${response.status}`);
  if (method === "DELETE") return undefined;
  return await response.json();
}

function validateCallback(value) {
  let callback;
  try { callback = new URL(value); } catch { fail("HBIEPA_WEBHOOK_CALLBACK_INVALID: callback must be an HTTPS URL."); }
  if (callback.protocol !== "https:" || !callback.hostname.endsWith(".trycloudflare.com") || callback.pathname !== callbackPath || callback.search || callback.hash) {
    fail("HBIEPA_WEBHOOK_CALLBACK_INVALID: callback must be the exact HTTPS Quick Tunnel webhook path.");
  }
}

async function updateEnvironment(next) {
  const existing = await readFile(envPath, "utf8");
  const values = Object.entries(next).filter(([, value]) => typeof value === "string");
  const present = new Set(values.map(([key]) => key));
  const updated = existing.split(/\r?\n/).map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !present.has(match[1])) return line;
    return `${match[1]}=${next[match[1]]}`;
  }).join("\n");
  const temporary = `${envPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, envPath);
}

function parseDotEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith("#")).map((line) => {
    const separator = line.indexOf("=");
    return separator < 1 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }).filter((pair) => pair.length === 2));
}

function suffix(value) { return value.slice(-8); }
function sanitize(error) { return (error instanceof Error ? error.message : "unexpected error").replace(/Bearer\s+\S+|Basic\s+\S+|[A-Za-z0-9_-]{24,}/g, "[redacted]"); }
function fail(message) { throw new Error(message); }
