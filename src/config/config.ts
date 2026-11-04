export const STAGE_0_OPERATION_MODE = "simulation-only" as const;

export type Stage0Config = Readonly<{
  operationMode: typeof STAGE_0_OPERATION_MODE;
}>;

/** No alternate mode exists: a caller cannot enable live execution by configuration. */
export function loadStage0Config(environment: NodeJS.ProcessEnv = process.env): Stage0Config {
  if (environment.HBIEPA_OPERATION_MODE && environment.HBIEPA_OPERATION_MODE !== STAGE_0_OPERATION_MODE) {
    throw new Error("HBIEPA Stage 0 is structurally simulation-only; live modes are invalid.");
  }
  return { operationMode: STAGE_0_OPERATION_MODE };
}

/** Stage 1 can communicate only with the PayPal sandbox and mock payout code. */
export const STAGE_1_OPERATION_MODE = "sandbox-simulation" as const;
export const PAYPAL_SANDBOX_ORIGIN = "https://api-m.sandbox.paypal.com" as const;

export type Stage1Config = Readonly<{
  operationMode: typeof STAGE_1_OPERATION_MODE;
  paypalClientId?: string;
  paypalClientSecret?: string;
  paypalMerchantId?: string;
  paypalWebhookId?: string;
}>;

export function loadStage1Config(environment: NodeJS.ProcessEnv = process.env): Stage1Config {
  const configuredMode = environment.HBIEPA_OPERATION_MODE;
  if (configuredMode && configuredMode !== STAGE_1_OPERATION_MODE) {
    throw new Error("HBIEPA Stage 1 permits only sandbox-simulation mode; live modes are invalid.");
  }
  const configuredOrigin = environment.PAYPAL_API_ORIGIN;
  if (configuredOrigin && configuredOrigin !== PAYPAL_SANDBOX_ORIGIN) {
    throw new Error("Only the exact PayPal sandbox API origin is permitted.");
  }
  return {
    operationMode: STAGE_1_OPERATION_MODE,
    paypalClientId: environment.PAYPAL_SANDBOX_CLIENT_ID,
    paypalClientSecret: environment.PAYPAL_SANDBOX_CLIENT_SECRET,
    paypalMerchantId: environment.PAYPAL_SANDBOX_MERCHANT_ID,
    paypalWebhookId: environment.PAYPAL_SANDBOX_WEBHOOK_ID,
  };
}
