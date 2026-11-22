// Fix round 2 re-review, D-32 (F7 CORE): the BFF's local payment-provider stand-in signs and posts a
// fake-provider "subscription active" webhook to payments whenever FAKE_PROVIDER_WEBHOOK_SECRET is set
// on the web. In production that same secret is what payments requires for its fake provider, so a
// shared secret would activate every checkout without payment.
//
// The choke point is the BFF config (readBffConfig -> fakeProviderSecret), the only way the secret
// reaches the stand-in.
//
// FR2-PAY-0 (green control): outside production, with the secret, the stand-in posts the webhook.
// FR2-PAY-1 (RED at 6298275): with NODE_ENV=production the BFF never posts or signs a fake-provider
//   webhook, even with the secret set.
// FR2-PAY-2 (green): with the fake provider not configured (no secret) nothing is posted.
// Mutation once fixed: read FAKE_PROVIDER_WEBHOOK_SECRET into `fakeProviderSecret` without the
//   production check (today's config.ts) -> FR2-PAY-1 red.
//
// Note for the fix: the web image sets NODE_ENV=production, compose included, so keeping the demo
// stand-in in compose needs compose to run the web with a non-production NODE_ENV or an explicit
// local-only switch that production refuses.
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const PLAN = {
  id: U(20),
  code: 'pro',
  name: 'Pro',
  interval: 'month',
  price_minor: 4900,
  currency: 'USD',
};
const ATTEMPT = {
  id: U(21),
  plan_id: U(20),
  subscription_id: U(22),
  state: 'processing',
  card_last4: '4242',
  card_brand: 'visa',
  created_at: '2026-11-22T10:00:00.000Z',
  updated_at: '2026-11-22T10:00:00.000Z',
};
const ROUTES: Record<string, unknown> = {
  'GET /v1/billing/plans': [PLAN],
  'POST /v1/billing/attempts': ATTEMPT,
  'GET /v1/operator/plan': { provider_subscription_id: 'sub_fake_1' },
  'POST /v1/billing/webhooks': { outcome: 'applied' },
};

async function checkout(env: Record<string, string>) {
  const calls: { url: string; signed: boolean }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: u.pathname, signed: 'x-webhook-signature' in headers });
    if (method === 'POST' && u.pathname === '/v1/auth/login') {
      const aud = (JSON.parse(String(init.body)) as { audience: string }).audience;
      return new Response(
        JSON.stringify({
          access_token: jwt({ sub: U(9), tid: U(8), roles: ['operator_admin'], aud }),
          token_type: 'Bearer',
          expires_in: 900,
        }),
        { status: 200 },
      );
    }
    const body = ROUTES[`${method} ${u.pathname}`];
    if (body === undefined) return new Response('{"code":"nope"}', { status: 404 });
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200 });
  }) as unknown as typeof fetch;
  const bff = createBff({
    config: readBffConfig({
      IDENTITY_URL: 'http://identity',
      PAYMENTS_URL: 'http://payments',
      ENGAGEMENT_URL: 'http://engagement',
      ...env,
    }),
    sessions: createMemorySessionStore(),
    fetch: fetchImpl,
  });
  let cookie = '';
  const req = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
    const res = await bff.handle(
      new Request(`http://web${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
        body: JSON.stringify(body),
      }),
    );
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res.status;
  };
  expect(await req('/api/session/login', { email: 'o@x.io', password: 'correct horse' })).toBe(200);
  const status = await req(
    '/api/operator/payments',
    { planId: 'pro', cardNumber: '4242 4242 4242 4242' },
    { 'idempotency-key': 'plan-key-0001' },
  );
  const webhook = calls.filter((c) => c.url === '/v1/billing/webhooks');
  return { status, posted: webhook.length, signed: webhook.some((c) => c.signed), calls };
}

describe('fix round 2: the fake-provider stand-in never runs in production (D-32, F7)', () => {
  it('FR2-PAY-0 control: outside production, with the secret, the stand-in posts a signed webhook', async () => {
    const r = await checkout({ NODE_ENV: 'development', FAKE_PROVIDER_WEBHOOK_SECRET: 's3cret' });
    expect({ status: r.status, posted: r.posted, signed: r.signed }).toEqual({
      status: 201,
      posted: 1,
      signed: true,
    });
  });

  it('FR2-PAY-1 with NODE_ENV=production the BFF neither signs nor posts a fake-provider webhook', async () => {
    const r = await checkout({ NODE_ENV: 'production', FAKE_PROVIDER_WEBHOOK_SECRET: 's3cret' });
    expect(r.calls.some((c) => c.url === '/v1/billing/attempts')).toBe(true); // the checkout ran
    expect({ posted: r.posted, signed: r.signed }).toEqual({ posted: 0, signed: false });
  });

  it('FR2-PAY-2 with the fake provider not configured nothing is posted', async () => {
    const r = await checkout({ NODE_ENV: 'development' });
    expect(r.calls.some((c) => c.url === '/v1/billing/attempts')).toBe(true);
    expect({ posted: r.posted, signed: r.signed }).toEqual({ posted: 0, signed: false });
  });
});
