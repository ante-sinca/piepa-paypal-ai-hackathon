import { createHash, randomUUID } from "node:crypto";
import { PAYPAL_SANDBOX_ORIGIN } from "../config/config.js";
import type { CurrencyAmount, PaymentEvidence } from "../contracts/envelope.js";

export type PayPalSandboxCredentials = Readonly<{ clientId: string; clientSecret: string }>;
export type FetchResponse = Readonly<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
export type FetchLike = (url: string, init: Readonly<{ method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }>) => Promise<FetchResponse>;
export const PAYPAL_SANDBOX_REQUEST_TIMEOUT_MS = 15_000;

export type PayPalSandboxPreflight = Readonly<{
  status: "PASS" | "FAIL";
  display: "PAYPAL SANDBOX PREFLIGHT: PASS" | "PAYPAL SANDBOX PREFLIGHT: FAIL";
  endpoint: typeof PAYPAL_SANDBOX_ORIGIN;
  clientIdFingerprint: string;
  applicationId?: string;
  expectedMerchantId: string;
  reasons: readonly string[];
}>;

/** Sanitised authenticated-API failure; it deliberately contains no token or request header. */
export class PayPalSandboxApiError extends Error {
  constructor(readonly httpStatus: number, readonly providerCode?: string, readonly debugId?: string) {
    super(`PAYPAL_SANDBOX_API_HTTP_${httpStatus}${providerCode ? `:${providerCode}` : ""}`);
  }
}

export type PayPalOrder = Readonly<{
  id: string;
  status: string;
  purchase_units?: readonly {
    custom_id?: string;
    payee?: { merchant_id?: string };
    amount?: { currency_code: string; value: string };
    payments?: { captures?: readonly { id: string; status: string; amount: { currency_code: string; value: string }; custom_id?: string }[] };
  }[];
  links?: readonly { href: string; rel: string; method?: string }[];
}>;

const assertExactSandboxUrl = (url: string): void => {
  const parsed = new URL(url);
  if (parsed.origin !== PAYPAL_SANDBOX_ORIGIN || parsed.protocol !== "https:") throw new Error("Live or unapproved PayPal endpoint rejected");
};

/** Minimal REST client. Credentials stay outside the repository and are never logged. */
export class PayPalSandboxOrdersAdapter {
  readonly provider = "paypal-sandbox";
  private readonly fetcher: FetchLike;

  constructor(private readonly credentials: PayPalSandboxCredentials, fetcher?: FetchLike, private readonly requestTimeoutMs = PAYPAL_SANDBOX_REQUEST_TIMEOUT_MS) {
    if (!credentials.clientId || !credentials.clientSecret) throw new Error("Missing PayPal sandbox credentials");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) throw new Error("PayPal sandbox request timeout must be 1-60 seconds");
    this.fetcher = fetcher ?? ((url, init) => fetch(url, init) as Promise<FetchResponse>);
  }

  /** Non-secret stable identity suitable for durable session metadata and operator comparison. */
  get clientIdFingerprint(): string { return createHash("sha256").update(this.credentials.clientId, "utf8").digest("hex").slice(0, 16); }

  /** Read-only credential/environment gate. OAuth proves application access, not transaction-level merchant identity. */
  async preflight(input: Readonly<{ expectedMerchantId: string }>): Promise<PayPalSandboxPreflight> {
    const authenticated = await this.authentication();
    return {
      status: "PASS", display: "PAYPAL SANDBOX PREFLIGHT: PASS",
      endpoint: PAYPAL_SANDBOX_ORIGIN, clientIdFingerprint: this.clientIdFingerprint, applicationId: authenticated.applicationId,
      expectedMerchantId: input.expectedMerchantId, reasons: [],
    };
  }

  async createOrder(input: Readonly<{ correlationId: string; amount: CurrencyAmount; returnUrl: string; cancelUrl: string; merchantId?: string; requestId?: string }>): Promise<{ orderId: string; approvalUrl?: string }> {
    const requestId = input.requestId ?? randomUUID();
    const body = {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "HBIEPA", custom_id: input.correlationId, amount: { currency_code: input.amount.currency, value: input.amount.value }, ...(input.merchantId ? { payee: { merchant_id: input.merchantId } } : {}) }],
      application_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: "PAY_NOW" },
    };
    const order = await this.api<PayPalOrder>("/v2/checkout/orders", "POST", body, requestId);
    if (!order.id) throw new Error("PayPal sandbox response did not include an order ID");
    return { orderId: order.id, approvalUrl: order.links?.find((link) => link.rel === "approve" || link.rel === "payer-action")?.href };
  }

  async captureOrder(orderId: string, requestId = randomUUID()): Promise<PayPalOrder> {
    return this.api<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, "POST", {} , requestId);
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    return this.api<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, "GET");
  }

  /** Proves OAuth credentials were accepted without exposing the issued token. */
  async verifySandboxAuthentication(): Promise<Readonly<{ environment: "paypal-sandbox"; applicationId?: string; clientIdFingerprint: string }>> {
    const authenticated = await this.authentication();
    return { environment: "paypal-sandbox", applicationId: authenticated.applicationId, clientIdFingerprint: this.clientIdFingerprint };
  }

  /** This independent GET is mandatory after capture or a webhook; callback data alone is never used. */
  async retrieveCaptureEvidence(orderId: string): Promise<{ evidence: PaymentEvidence; rawOrder: string }> {
    const order = await this.getOrder(orderId);
    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (!unit || !capture) throw new Error("Retrieved order contains no capture evidence");
    return {
      evidence: {
        provider: "paypal-sandbox", resourceId: order.id, captureId: capture.id,
        correlationId: capture.custom_id ?? unit.custom_id, merchantId: unit.payee?.merchant_id,
        amount: { currency: capture.amount.currency_code, value: capture.amount.value },
        status: capture.status === "COMPLETED" ? "COMPLETED" : capture.status === "DECLINED" ? "DECLINED" : capture.status === "PENDING" ? "PENDING" : "UNKNOWN",
        independentlyRetrievedAt: new Date().toISOString(), isSynthetic: false,
      },
      rawOrder: JSON.stringify(order),
    };
  }

  async verifyWebhookSignature(input: Readonly<{ headers: Record<string, string>; rawBody: string; webhookId: string }>): Promise<boolean> {
    const event = JSON.parse(input.rawBody) as unknown;
    const headers = lowerCaseHeaders(input.headers);
    const response = await this.api<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", "POST", {
      auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"], transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"], webhook_id: input.webhookId, webhook_event: event,
    });
    return response.verification_status === "SUCCESS";
  }

  /** Uses the same credentials and exact sandbox-origin guard as Orders. */
  async paymentLinkApi<T>(path: `/v1/checkout/payment-resources${string}`, method: "GET" | "POST", body?: unknown, requestId?: string): Promise<T> {
    return this.api<T>(path, method, body, requestId);
  }

  private async api<T>(path: string, method: "GET" | "POST", body?: unknown, requestId?: string): Promise<T> {
    const { accessToken } = await this.authentication();
    const url = `${PAYPAL_SANDBOX_ORIGIN}${path}`;
    assertExactSandboxUrl(url);
    let response: FetchResponse;
    try {
      response = await this.request(url, { method, headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) }, "ORDERS");
    } catch (error) {
      if (error instanceof Error && error.message === "PAYPAL_SANDBOX_ORDERS_TIMEOUT") throw error;
      throw new Error(`PayPal sandbox transport failure at authenticated API request (${transportCode(error)})`);
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined) as { name?: unknown; debug_id?: unknown } | undefined;
      throw new PayPalSandboxApiError(response.status, safeProviderValue(failure?.name), safeProviderValue(failure?.debug_id));
    }
    return await response.json() as T;
  }

  private async authentication(): Promise<Readonly<{ accessToken: string; applicationId?: string }>> {
    const url = `${PAYPAL_SANDBOX_ORIGIN}/v1/oauth2/token`;
    assertExactSandboxUrl(url);
    const encoded = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`, "utf8").toString("base64");
    let response: FetchResponse;
    try {
      response = await this.request(url, { method: "POST", headers: { Authorization: `Basic ${encoded}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: "grant_type=client_credentials" }, "OAUTH");
    } catch (error) {
      if (error instanceof Error && error.message === "PAYPAL_SANDBOX_OAUTH_TIMEOUT") throw error;
      throw new Error(`PayPal sandbox transport failure at OAuth token request (${transportCode(error)})`);
    }
    if (!response.ok) throw new Error("Unable to obtain PayPal sandbox access token");
    const payload = await response.json() as { access_token?: string };
    if (!payload.access_token) throw new Error("PayPal sandbox token response omitted access_token");
    return { accessToken: payload.access_token, applicationId: safeApplicationId((payload as { app_id?: unknown }).app_id) };
  }

  private async request(url: string, init: Readonly<{ method: string; headers: Record<string, string>; body?: string }>, phase: "OAUTH" | "ORDERS"): Promise<FetchResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`PAYPAL_SANDBOX_${phase}_TIMEOUT`)); }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([this.fetcher(url, { ...init, signal: controller.signal }), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export type PayPalPaymentLink = Readonly<{ id: string; payment_link?: string; links?: readonly { href: string; rel: string }[]; reusable?: string }>;

/** Payment Links deliberately has no HBIEPA custom_id assumption. Its result must be researched per capture. */
export class PayPalSandboxPaymentLinksAdapter {
  constructor(private readonly orders: PayPalSandboxOrdersAdapter) {}

  async createReusableLink(input: Readonly<{ name: string; amount: CurrencyAmount; returnUrl: string }>): Promise<PayPalPaymentLink> {
    return this.orders.paymentLinkApi<PayPalPaymentLink>("/v1/checkout/payment-resources", "POST", {
      integration_mode: "LINK", type: "BUY_NOW", reusable: "MULTIPLE", return_url: input.returnUrl,
      line_items: [{ name: input.name, unit_amount: { currency_code: input.amount.currency, value: input.amount.value } }],
    }, randomUUID());
  }

  async getPaymentLink(paymentLinkId: string): Promise<PayPalPaymentLink> {
    return this.orders.paymentLinkApi<PayPalPaymentLink>(`/v1/checkout/payment-resources/${encodeURIComponent(paymentLinkId)}`, "GET");
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function transportCode(error: unknown): string {
  const direct = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = typeof direct?.code === "string" ? direct.code : typeof direct?.cause?.code === "string" ? direct.cause.code : "UNKNOWN";
  return code.replace(/[^A-Z0-9_]/gi, "").slice(0, 40) || "UNKNOWN";
}

function safeProviderValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9_]{1,80}$/i.test(value) ? value : undefined;
}

function safeApplicationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9-]{1,80}$/i.test(value) ? value : undefined;
}
