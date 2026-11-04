import { createHash } from "node:crypto";
import type { PayPalSandboxOrdersAdapter } from "../adapters/paypal-sandbox.js";
import type { WebhookRecord, WebhookSource } from "../persistence/local-ledger.js";
import type { Stage1Persistence } from "../persistence/contracts.js";

export type IngressResult = Readonly<{ accepted: boolean; duplicate: boolean; verification: WebhookRecord["verification"]; processing: WebhookRecord["processing"] }>;

/** Durable ingress: raw bytes are recorded before parsing; a webhook never authorises a payout. */
export class PayPalWebhookInbox {
  constructor(
    private readonly ledger: Stage1Persistence,
    private readonly webhookId: string | undefined,
    private readonly paypal?: PayPalSandboxOrdersAdapter,
    private readonly retrieveOrder?: (orderId: string) => Promise<void>,
  ) {}

  async receive(input: Readonly<{ rawBody: string; headers: Record<string, string>; source: WebhookSource; receivedAt?: Date }>): Promise<IngressResult> {
    const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const deliveryId = headers["paypal-transmission-id"] || `local-${createHash("sha256").update(input.rawBody).digest("base64url")}`;
    const record: WebhookRecord = {
      deliveryId, source: input.source, rawBody: input.rawBody, rawDigest: createHash("sha256").update(input.rawBody, "utf8").digest("base64url"), headers,
      receivedAt: (input.receivedAt ?? new Date()).toISOString(), verification: "PENDING", processing: "RECEIVED",
    };
    const inserted = await this.ledger.recordWebhook(record);
    if (inserted.duplicate) return { accepted: true, duplicate: true, verification: inserted.record.verification, processing: "DUPLICATE" };
    if (input.source !== "PAYPAL_SANDBOX") {
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "SYNTHETIC", processing: "WAITING_FOR_RESOURCE", failureReason: "Synthetic webhook cannot establish payment evidence" });
      return { accepted: true, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    }
    if (!this.webhookId || !this.paypal) {
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "REJECTED", processing: "FAILED", failureReason: "Sandbox webhook verification configuration is unavailable" });
      return { accepted: false, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    }
    const timestamp = Date.parse(headers["paypal-transmission-time"] ?? "");
    if (Number.isNaN(timestamp) || Math.abs((input.receivedAt ?? new Date()).getTime() - timestamp) > 5 * 60_000) {
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "REJECTED", processing: "FAILED", failureReason: "Webhook transmission timestamp is outside replay window" });
      return { accepted: false, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    }
    let verified = false;
    try { verified = await this.paypal.verifyWebhookSignature({ headers, rawBody: input.rawBody, webhookId: this.webhookId }); } catch { verified = false; }
    if (!verified) {
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "REJECTED", processing: "FAILED", failureReason: "PayPal signature verification failed" });
      return { accepted: false, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    }
    const event = JSON.parse(input.rawBody) as { resource?: { supplementary_data?: { related_ids?: { order_id?: string } }; id?: string } };
    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (!orderId || !this.retrieveOrder) {
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "VERIFIED", processing: "WAITING_FOR_RESOURCE" });
      return { accepted: true, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    }
    try {
      await this.retrieveOrder(orderId);
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "VERIFIED", processing: "RECONCILED" });
      return { accepted: true, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    } catch {
      const webhook = await this.ledger.updateWebhook(deliveryId, { verification: "VERIFIED", processing: "FAILED", failureReason: "Independent order retrieval failed; recovery required" });
      return { accepted: false, duplicate: false, verification: webhook.verification, processing: webhook.processing };
    }
  }
}
