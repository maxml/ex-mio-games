import type { ProviderSnapshot } from '@ex-mio/contracts';

/** Injection token of the active provider (see `selectPaymentProvider`). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** A webhook whose signature does not verify: refused before anything else happens (401). */
export class WebhookSignatureError extends Error {
  readonly code = 'invalid_signature' as const;
  constructor() {
    super('webhook signature is not valid');
    this.name = 'WebhookSignatureError';
  }
}

/** A card number that is not one of the provider's test cards. */
export class CardNotAcceptedError extends Error {
  constructor() {
    super('card number not accepted');
    this.name = 'CardNotAcceptedError';
  }
}

/** The plan a checkout is priced from: always the plan row, never a caller's claim. */
export interface ProviderPlan {
  code: string;
  priceMinor: number;
  currency: string;
}

export interface CardToken {
  token: string;
  brand: 'visa' | 'mastercard';
  last4: string;
}

export interface SubscribeInput {
  customerId: string;
  /** Echoed back in the webhook, so the callback names its tenant without trusting a header. */
  tenantId: string;
  plan: ProviderPlan;
  paymentMethod: string;
}

/** `subscribe` never reports `active`: activation arrives as a signed webhook. */
export type SubscribeResult =
  | { outcome: 'pending'; subscriptionId: string }
  | { outcome: 'declined' };

export interface ProviderSubscription {
  status: 'pending' | 'active' | 'past_due' | 'canceled';
}

export interface UsageReportCall {
  subscriptionId: string;
  period: string;
  quantity: number;
  idempotencyKey: string;
}

/**
 * The payment provider port (MIO-090). Verification of webhooks belongs to the adapter, is always on,
 * and fails closed with `WebhookSignatureError`. Money is integer minor units.
 */
export interface PaymentProvider {
  readonly kind: string;
  /** Exchange a card number for a token. The number goes no further than this call. */
  tokenize(card: string): CardToken;
  createCustomer(input: { tenantId: string; email: string }): Promise<{ customerId: string }>;
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  verifyWebhook(rawBody: string, signature: string | undefined): ProviderSnapshot;
  getSubscription(subscriptionId: string): Promise<ProviderSubscription>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  /** Idempotent per `idempotencyKey`: `recorded` is false for a key the provider already holds. */
  reportUsage(call: UsageReportCall): Promise<{ recorded: boolean }>;
}
