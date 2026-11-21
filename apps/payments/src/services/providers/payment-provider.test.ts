import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakePaymentProvider } from './fake.provider';
import { NotConfiguredError, StripePaymentProvider } from './stripe.provider';
import { selectPaymentProvider } from './select-provider';
import type { PaymentProvider } from './payment-provider';

// Choke point: the `PaymentProvider` port and its adapters. No database. Spec: section 9.

const plan = { code: 'pro', priceMinor: 4900, currency: 'USD' };

describe('INV-PP1 the fake provider: 4242 is ok, 0002 is declined', () => {
  // Mutation: accept every card, or decide by something other than the last four digits.
  it.each([
    ['4242424242424242', 'active'],
    ['4000000000000002', 'declined'],
  ])('card %s -> %s', async (card, outcome) => {
    const p: PaymentProvider = new FakePaymentProvider();
    const { customerId } = await p.createCustomer({ tenantId: 't', email: 'ops@example.test' });
    const res = await p.subscribe({ customerId, plan, cardNumber: card });
    expect(res.outcome).toBe(outcome);
    if (res.outcome === 'active') expect(res.subscriptionId).toEqual(expect.any(String));
  });

  it('cancel then getSubscription says canceled', async () => {
    const p = new FakePaymentProvider();
    const { customerId } = await p.createCustomer({ tenantId: 't', email: 'ops@example.test' });
    const res = await p.subscribe({ customerId, plan, cardNumber: '4242424242424242' });
    if (res.outcome !== 'active') throw new Error('expected active');
    await p.cancelSubscription(res.subscriptionId);
    expect((await p.getSubscription(res.subscriptionId)).status).toBe('canceled');
  });

  // Mutation: record a usage report per call instead of per idempotency key.
  it('reportUsage twice with one idempotency key is recorded once', async () => {
    const p = new FakePaymentProvider();
    const call = { subscriptionId: 's1', period: '2026-11', quantity: 5, idempotencyKey: 'k1' };
    expect((await p.reportUsage(call)).recorded).toBe(true);
    expect((await p.reportUsage(call)).recorded).toBe(false);
    expect(p.recordedUsage()).toHaveLength(1);
  });
});

describe('INV-PP2 the stripe adapter is a stub behind config', () => {
  // Mutation: make a Stripe method return a value instead of throwing NotConfigured.
  it('every method throws NotConfigured', async () => {
    const p = new StripePaymentProvider({ secretKey: 'sk_test_x' });
    const calls: Array<() => Promise<unknown>> = [
      () => p.createCustomer({ tenantId: 't', email: 'a@b.test' }),
      () => p.subscribe({ customerId: 'c', plan, cardNumber: '4242424242424242' }),
      () => p.getSubscription('s'),
      () => p.cancelSubscription('s'),
      () =>
        p.reportUsage({ subscriptionId: 's', period: '2026-11', quantity: 1, idempotencyKey: 'k' }),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  // Mutation: default to stripe, or pick the provider on every call instead of once.
  it('fake is the default; stripe is chosen only when STRIPE_SECRET_KEY is set', () => {
    expect(selectPaymentProvider({}).kind).toBe('fake');
    expect(selectPaymentProvider({ STRIPE_SECRET_KEY: '' }).kind).toBe('fake');
    expect(selectPaymentProvider({ STRIPE_SECRET_KEY: 'sk_test_x' }).kind).toBe('stripe');
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
