import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderSnapshot } from '@ex-mio/contracts';
import {
  CardNotAcceptedError,
  WebhookSignatureError,
  type CardToken,
  type PaymentProvider,
  type ProviderPlan,
  type ProviderSubscription,
  type SubscribeInput,
  type SubscribeResult,
  type UsageReportCall,
} from './payment-provider';

/** The test cards the fake provider knows, and the token each one becomes. */
const TEST_CARDS: Record<string, CardToken> = {
  '4242424242424242': { token: 'tok_4242', brand: 'visa', last4: '4242' },
  '5555555555554444': { token: 'tok_5555', brand: 'mastercard', last4: '4444' },
  '4000000000000002': { token: 'tok_0002', brand: 'visa', last4: '0002' },
};
/** Tokens that subscribe. Any other token, `tok_0002` included, is declined. */
const ACCEPTED_TOKENS = new Set(['tok_4242', 'tok_5555']);

export interface FakeCheckout {
  tenantId: string;
  customerId: string;
  plan: ProviderPlan;
}

/**
 * The default adapter: deterministic, in memory, no network. Webhooks are signed and verified with
 * HMAC-SHA256 of the raw body, hex encoded, with the configured secret.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly kind = 'fake';
  private readonly secret: string;
  private sequence = 0;
  private readonly subscriptions = new Map<string, ProviderSubscription['status']>();
  private readonly checkoutLog: FakeCheckout[] = [];
  private readonly usage = new Map<string, UsageReportCall>();

  constructor(options: { webhookSecret: string }) {
    this.secret = options.webhookSecret;
  }

  tokenize(card: string): CardToken {
    const known = Object.hasOwn(TEST_CARDS, card) ? TEST_CARDS[card] : undefined;
    if (!known) throw new CardNotAcceptedError();
    return { ...known };
  }

  async createCustomer(): Promise<{ customerId: string }> {
    return { customerId: `cus_fake_${++this.sequence}` };
  }

  async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    this.checkoutLog.push({
      tenantId: input.tenantId,
      customerId: input.customerId,
      plan: { ...input.plan },
    });
    if (!ACCEPTED_TOKENS.has(input.paymentMethod)) return { outcome: 'declined' };
    const subscriptionId = `sub_fake_${++this.sequence}_${Math.random().toString(36).slice(2, 10)}`;
    this.subscriptions.set(subscriptionId, 'pending');
    return { outcome: 'pending', subscriptionId };
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody: string, signature: string | undefined): ProviderSnapshot {
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
      throw new WebhookSignatureError();
    }
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureError();
    }
    return ProviderSnapshot.parse(JSON.parse(rawBody));
  }

  async getSubscription(subscriptionId: string): Promise<ProviderSubscription> {
    const status = this.subscriptions.get(subscriptionId);
    if (!status) throw new Error(`unknown subscription ${subscriptionId}`);
    return { status };
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    this.subscriptions.set(subscriptionId, 'canceled');
  }

  async reportUsage(call: UsageReportCall): Promise<{ recorded: boolean }> {
    if (this.usage.has(call.idempotencyKey)) return { recorded: false };
    this.usage.set(call.idempotencyKey, { ...call });
    return { recorded: true };
  }

  /** What was checked out, for tests. */
  checkouts(): FakeCheckout[] {
    return [...this.checkoutLog];
  }

  /** The usage reports the provider holds (one per idempotency key), for tests. */
  recordedUsage(): UsageReportCall[] {
    return [...this.usage.values()];
  }
}
