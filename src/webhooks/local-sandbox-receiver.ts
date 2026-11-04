import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PayPalWebhookInbox } from "./paypal-inbox.js";
import type { WebhookSource } from "../persistence/local-ledger.js";

export type LocalWebhookReceiver = Readonly<{
  callbackPath: string;
  start(port?: number): Promise<string>;
  stop(): Promise<void>;
}>;

/**
 * Loopback-only listener used to prove raw-body handling locally. It cannot be
 * reached from the public Internet; an explicitly approved temporary tunnel is
 * required before PayPal may deliver a genuine sandbox webhook.
 */
export function createLocalSandboxWebhookReceiver(input: Readonly<{
  inbox: PayPalWebhookInbox;
  callbackPath?: string;
  maxBodyBytes?: number;
  source?: WebhookSource;
}>): LocalWebhookReceiver {
  const callbackPath = input.callbackPath ?? "/webhooks/paypal/sandbox";
  const maxBodyBytes = input.maxBodyBytes ?? 1_048_576;
  let server: Server | undefined;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST" || new URL(request.url ?? "/", "http://localhost").pathname !== callbackPath) {
      response.writeHead(404).end();
      return;
    }
    try {
      const rawBody = await readRawBody(request, maxBodyBytes);
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value as string]));
      const result = await input.inbox.receive({ rawBody, headers, source: input.source ?? "PAYPAL_SANDBOX" });
      response.writeHead(result.accepted ? 200 : 400, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ accepted: result.accepted, duplicate: result.duplicate }));
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 400;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ accepted: false }));
    }
  };

  return {
    callbackPath,
    async start(port = 0): Promise<string> {
      if (server) throw new Error("Local sandbox webhook receiver is already running");
      server = createServer((request, response) => { void handler(request, response); });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
      });
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}${callbackPath}`;
    },
    async stop(): Promise<void> {
      if (!server) return;
      const active = server;
      server = undefined;
      active.closeIdleConnections();
      active.closeAllConnections();
      await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    },
  };
}

class BodyTooLargeError extends Error {}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      request.destroy();
      throw new BodyTooLargeError("Webhook payload exceeds local safety limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
