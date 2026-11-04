import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const envPath = new URL("../.env", import.meta.url);
if (!existsSync(envPath)) {
  console.error("HBIEPA_SANDBOX_CONFIGURATION_MISSING: create an ignored .env from .env.example; no network request was made.");
  process.exitCode = 2;
} else {
  const environment = parseDotEnv(await readFile(envPath, "utf8"));
  const clientId = environment.PAYPAL_SANDBOX_CLIENT_ID;
  const clientSecret = environment.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("HBIEPA_SANDBOX_CONFIGURATION_MISSING: client ID and client secret are required; no network request was made.");
    process.exitCode = 2;
  } else {
    try {
      const { PayPalSandboxOrdersAdapter } = await import("../dist/src/index.js");
      const adapter = new PayPalSandboxOrdersAdapter({ clientId, clientSecret });
      await adapter.verifySandboxAuthentication();
      console.log("HBIEPA_PAYPAL_SANDBOX_OAUTH_VERIFIED");
    } catch (error) {
      console.error(`HBIEPA_PAYPAL_SANDBOX_OAUTH_FAILED: ${sanitize(error)}`);
      process.exitCode = 1;
    }
  }
}

function parseDotEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#"))
    .map((line) => { const separator = line.indexOf("="); return separator < 1 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]; })
    .filter((pair) => pair.length === 2));
}

function sanitize(error) {
  const message = error instanceof Error ? error.message : "unexpected error";
  return message.replace(/Bearer\s+\S+|Basic\s+\S+|[A-Za-z0-9_-]{24,}/g, "[redacted]");
}
