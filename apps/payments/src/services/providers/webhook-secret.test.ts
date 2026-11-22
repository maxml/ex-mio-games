import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectPaymentProvider } from './select-provider';

// Choke point: `selectPaymentProvider`, the only place the webhook secret is chosen (D-20, R-3).
// The reviewer's INV-PP2 (payment-provider.test.ts) tries every string literal of the provider
// sources as the secret; these pin the rule itself: no value in the source, production refuses to
// start without a secret of 32+ characters, and a development process without one gets a random one.

const BODY = JSON.stringify({
  eventId: 'evt_x',
  tenantId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a',
  subscriptionId: 'sub_x',
  status: 'active',
  version: 1,
  amountMinor: 4900,
  currency: 'USD',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
});
const sign = (secret: string) => createHmac('sha256', secret).update(BODY).digest('hex');
const GOOD = 'a-production-secret-of-at-least-32-chars';

describe('webhook secret', () => {
  // Mutation: fall back to a secret when production has none (or accept a short one).
  it('production without a secret, with an empty one or with a short one refuses to start', () => {
    for (const secret of [undefined, '', 'short', 'x'.repeat(31)]) {
      expect(() =>
        selectPaymentProvider({ NODE_ENV: 'production', FAKE_PROVIDER_WEBHOOK_SECRET: secret }),
      ).toThrow(/FAKE_PROVIDER_WEBHOOK_SECRET is required in production/);
    }
  });

  it('production with a 32+ character secret verifies a webhook signed with exactly that secret', () => {
    const p = selectPaymentProvider({ NODE_ENV: 'production', FAKE_PROVIDER_WEBHOOK_SECRET: GOOD });
    expect(() => p.verifyWebhook(BODY, sign(GOOD))).not.toThrow();
    expect(() => p.verifyWebhook(BODY, sign('another-secret-of-at-least-32-chars-x'))).toThrow();
  });

  // Mutation: a fixed development secret in the source (anyone who reads the repository can sign).
  it('outside production a missing secret is random per process: nothing in the source signs a webhook', () => {
    const a = selectPaymentProvider({ NODE_ENV: 'development' });
    const b = selectPaymentProvider({});
    const sources = ['select-provider.ts', 'fake.provider.ts']
      .map((f) => readFileSync(join(__dirname, f), 'utf8'))
      .join('\n');
    const literals = [...sources.matchAll(/['"`]([^'"`\s]{8,})['"`]/g)].map((m) => m[1]!);
    for (const p of [a, b]) {
      for (const literal of literals) expect(() => p.verifyWebhook(BODY, sign(literal))).toThrow();
    }
    expect(literals.length).toBeGreaterThan(0); // the scan reads real source
  });

  it('a configured secret is honoured outside production too (compose sets one)', () => {
    const p = selectPaymentProvider({
      NODE_ENV: 'development',
      FAKE_PROVIDER_WEBHOOK_SECRET: GOOD,
    });
    expect(() => p.verifyWebhook(BODY, sign(GOOD))).not.toThrow();
  });
});
