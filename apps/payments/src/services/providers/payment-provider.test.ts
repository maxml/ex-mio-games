import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakePaymentProvider } from './fake.provider';
import { NotConfiguredError, StripePaymentProvider } from './stripe.provider';
import { selectPaymentProvider } from './select-provider';
import { WebhookSignatureError, type PaymentProvider } from './payment-provider';

// Choke point: the `PaymentProvider` port and its adapters. No database. Spec: section 9.

const plan = { code: 'pro', priceMinor: 4900, currency: 'USD' };
const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const SECRET = 'whsec_test_secret';

describe('INV-PP1 the fake provider: tok_4242 is accepted (pending), tok_0002 is declined', () => {
  // Mutation: accept every token, or decide by something other than the token.
  it.each([
    ['tok_4242', 'pending'],
    ['tok_0002', 'declined'],
  ])('token %s -> %s', async (paymentMethod, outcome) => {
    const p: PaymentProvider = new FakePaymentProvider({ webhookSecret: SECRET });
    const { customerId } = await p.createCustomer({ tenantId: TENANT, email: 'ops@example.test' });
    const res = await p.subscribe({ customerId, tenantId: TENANT, plan, paymentMethod });
    expect(res.outcome).toBe(outcome);
    if (res.outcome === 'pending') expect(res.subscriptionId).toEqual(expect.any(String));
  });

  // The activation never comes back from `subscribe`: it arrives as a signed webhook (MIO-093).
  // Mutation: return `active` from subscribe.
  it('subscribe never reports active', async () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const { customerId } = await p.createCustomer({ tenantId: TENANT, email: 'ops@example.test' });
    const res = await p.subscribe({
      customerId,
      tenantId: TENANT,
      plan,
      paymentMethod: 'tok_4242',
    });
    expect(res.outcome).not.toBe('active');
  });

  // Mutation: record only the plan code, or drop the tenant metadata the webhook needs.
  it('records every checkout with the plan it was priced from and the tenant', async () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const { customerId } = await p.createCustomer({ tenantId: TENANT, email: 'ops@example.test' });
    await p.subscribe({ customerId, tenantId: TENANT, plan, paymentMethod: 'tok_4242' });
    expect(p.checkouts()).toEqual([{ tenantId: TENANT, customerId, plan }]);
  });

  it('cancel then getSubscription says canceled', async () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const { customerId } = await p.createCustomer({ tenantId: TENANT, email: 'ops@example.test' });
    const res = await p.subscribe({
      customerId,
      tenantId: TENANT,
      plan,
      paymentMethod: 'tok_4242',
    });
    if (res.outcome !== 'pending') throw new Error('expected pending');
    await p.cancelSubscription(res.subscriptionId);
    expect((await p.getSubscription(res.subscriptionId)).status).toBe('canceled');
  });

  // Mutation: record a usage report per call instead of per idempotency key.
  it('reportUsage twice with one idempotency key is recorded once', async () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const call = { subscriptionId: 's1', period: '2026-11', quantity: 5, idempotencyKey: 'k1' };
    expect((await p.reportUsage(call)).recorded).toBe(true);
    expect((await p.reportUsage(call)).recorded).toBe(false);
    expect(p.recordedUsage()).toEqual([call]);
  });
});

describe('INV-PP5 the fake provider accepts only test card numbers and returns last4 and brand', () => {
  // Mutation: accept any 16 digits, or return the number itself.
  it.each([
    ['4242424242424242', 'tok_4242', 'visa', '4242'],
    ['5555555555554444', 'tok_5555', 'mastercard', '4444'],
    ['4000000000000002', 'tok_0002', 'visa', '0002'],
  ])('card %s', (card, token, brand, last4) => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const t = p.tokenize(card);
    expect(t).toEqual({ token, brand, last4 });
    expect(JSON.stringify(t)).not.toContain(card);
  });

  it.each(['4111111111111111', '1234567890123456', '4242'])('%s is not a test card', (card) => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    expect(() => p.tokenize(card)).toThrow(/not accepted/i);
  });
});

describe("INV-PP4 webhook verification is the provider adapter's job and fails closed", () => {
  const body = JSON.stringify({
    eventId: 'evt_1',
    tenantId: TENANT,
    subscriptionId: 'sub_1',
    status: 'active',
    version: 2,
    amountMinor: 4900,
    currency: 'USD',
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
  });

  // Mutation: return the parsed body without checking the HMAC, or compare with `===` on a
  // wrong-length value that throws something other than WebhookSignatureError.
  it('a body signed with the secret verifies to a typed snapshot', () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    expect(p.verifyWebhook(body, p.sign(body))).toMatchObject({
      eventId: 'evt_1',
      tenantId: TENANT,
      subscriptionId: 'sub_1',
      status: 'active',
      version: 2,
    });
  });

  it.each([undefined, '', 'zz', 'a'.repeat(64), 'a'.repeat(7)])(
    'signature %p is a WebhookSignatureError',
    (sig) => {
      const p = new FakePaymentProvider({ webhookSecret: SECRET });
      expect(() => p.verifyWebhook(body, sig as string)).toThrow(WebhookSignatureError);
    },
  );

  it('a different secret, or a changed body, fails', () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const other = new FakePaymentProvider({ webhookSecret: 'whsec_other' });
    expect(() => p.verifyWebhook(body, other.sign(body))).toThrow(WebhookSignatureError);
    expect(() => p.verifyWebhook(body + ' ', p.sign(body))).toThrow(WebhookSignatureError);
  });

  // A verified body that is not a snapshot is not applied either.
  it('a signed body that is not a valid snapshot is refused', () => {
    const p = new FakePaymentProvider({ webhookSecret: SECRET });
    const junk = JSON.stringify({ eventId: 'e', status: 'rich' });
    expect(() => p.verifyWebhook(junk, p.sign(junk))).toThrow();
  });
});

describe('INV-PP2 the stripe adapter is a stub behind config', () => {
  // Mutation: make a Stripe method return a value instead of throwing NotConfigured.
  it('every method throws NotConfigured', async () => {
    const p = new StripePaymentProvider({ secretKey: 'sk_test_x' });
    const calls: Array<() => unknown> = [
      () => p.createCustomer({ tenantId: TENANT, email: 'a@b.test' }),
      () => p.subscribe({ customerId: 'c', tenantId: TENANT, plan, paymentMethod: 'tok_4242' }),
      () => p.getSubscription('s'),
      () => p.cancelSubscription('s'),
      () =>
        p.reportUsage({ subscriptionId: 's', period: '2026-11', quantity: 1, idempotencyKey: 'k' }),
      () => p.verifyWebhook('{}', 'sig'),
      () => p.tokenize('4242424242424242'),
    ];
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(NotConfiguredError);
    }
  });

  // Mutation: default to stripe, or pick the provider on every call instead of once.
  it('fake is the default; stripe is chosen only when STRIPE_SECRET_KEY is set', () => {
    expect(selectPaymentProvider({}).kind).toBe('fake');
    expect(selectPaymentProvider({ STRIPE_SECRET_KEY: '' }).kind).toBe('fake');
    expect(selectPaymentProvider({ STRIPE_SECRET_KEY: 'sk_test_x' }).kind).toBe('stripe');
  });

  // Reviewer test (Stage B, finding R-3): webhook verification must fail CLOSED in production. Today a
  // production process without FAKE_PROVIDER_WEBHOOK_SECRET falls back to a secret written in the
  // source, so anyone who reads the repository can sign an `active` webhook and get a paid plan.
  // Mutation: fall back to a source-code secret when NODE_ENV=production.
  it('production without a webhook secret never verifies a webhook signed with a secret from the source', () => {
    const body = JSON.stringify({
      eventId: 'evt_forged',
      tenantId: TENANT,
      subscriptionId: 'sub_x',
      status: 'active',
      version: 99,
      amountMinor: 0,
      currency: 'USD',
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-12-01T00:00:00.000Z',
    });
    const sources = ['select-provider.ts', 'fake.provider.ts', 'payment-provider.ts']
      .map((f) => readFileSync(join(__dirname, f), 'utf8'))
      .join('\n');
    const literals = [...sources.matchAll(/['"`]([^'"`\s]{8,})['"`]/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(0); // the scan reads real source, not an empty string
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', FAKE_PROVIDER_WEBHOOK_SECRET: '' },
    ]) {
      let p: PaymentProvider;
      try {
        p = selectPaymentProvider(env);
      } catch {
        continue; // refusing to start is failing closed too
      }
      for (const secret of literals) {
        const forged = createHmac('sha256', secret).update(body).digest('hex');
        expect(() => p.verifyWebhook(body, forged)).toThrow();
      }
    }
  });
});

describe('INV-PP3 no Stripe name leaks outside its adapter', () => {
  // Mutation: import or mention the stripe SDK/types in any other source file.
  it('only providers/stripe.provider.ts (and this test) mention stripe', () => {
    const root = join(__dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.ts$/.test(name) &&
          !/stripe\.provider\.ts$|\.test\.ts$|\.pgtest\.ts$/.test(name)
        ) {
          if (/from\s+['"]stripe['"]|\bStripe\./.test(readFileSync(path, 'utf8'))) hits.push(path);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
    expect(statSync(join(__dirname, 'stripe.provider.ts')).isFile()).toBe(true);
  });
});
