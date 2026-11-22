// BFF: the operator console's credentials, rules and wheel go to the real services (identity, engagement).
// Mutation per test: change the mapped field named in the test name and that test turns red.
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string;
}

async function signedIn(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const loginHosts: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: u.pathname, body, auth: headers.authorization ?? '' });
    if (u.pathname === '/v1/auth/login') loginHosts.push(headers.host ?? '');
    if (method === 'POST' && u.pathname === '/v1/auth/login') {
      const aud = (body as { audience: string }).audience;
      return new Response(
        JSON.stringify({
          access_token: jwt({ sub: U(9), tid: U(8), roles: ['operator_admin'], aud }),
          token_type: 'Bearer',
          expires_in: 900,
        }),
        { status: 200 },
      );
    }
    const r = routes[`${method} ${u.pathname}`];
    if (!r) return new Response('{"message":"no route","code":"nope"}', { status: 404 });
    return new Response(JSON.stringify(r.body === undefined ? {} : r.body), {
      status: r.status ?? 200,
    });
  }) as unknown as typeof fetch;
  const bff = createBff({
    config: readBffConfig({
      IDENTITY_URL: 'http://identity',
      PAYMENTS_URL: 'http://payments',
      ENGAGEMENT_URL: 'http://engagement',
    }),
    sessions: createMemorySessionStore(),
    fetch: fetchImpl,
  });
  let cookie = '';
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await bff.handle(
      new Request(`http://web${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  await req('POST', '/api/session/login', { email: 'o@x.io', password: 'correct horse' });
  calls.length = 0;
  return { calls, req, loginHosts };
}

describe('tenant host', () => {
  it('signup logs in as <slug>.<BASE_DOMAIN>, whatever host the browser is on', async () => {
    // Mutation: send the browser host (`web`) instead and identity answers TENANT_UNRESOLVED.
    const w = await signedIn({
      'POST /v1/operators/signup': {
        status: 201,
        body: {
          tenant: {
            id: U(8),
            slug: 'acme-casino',
            name: 'Acme Casino',
            type: 'operator',
            status: 'active',
          },
          user: { id: U(9), email: 'a@acme.example', roles: ['operator_admin'] },
        },
      },
    });
    w.loginHosts.length = 0;
    await w.req('POST', '/api/operator/account', {
      companyName: 'Acme Casino',
      email: 'a@acme.example',
      password: 'correct horse',
    });
    expect(w.loginHosts.length).toBeGreaterThan(0);
    expect(new Set(w.loginHosts)).toEqual(new Set(['acme-casino.mio.localhost']));
  });
});

describe('operator console state against the real payments answers', () => {
  it('no subscription yet is 200 with a JSON null and the console state still composes', async () => {
    const w = await signedIn({
      'GET /v1/billing/plans': { body: [] },
      'GET /v1/billing/subscription': { body: null },
      'GET /v1/billing/invoices': { body: [] },
      'GET /v1/billing/usage': { body: { period: '2026-11', spins: 3, monthly_active_players: 2 } },
      'GET /v1/store/items': { body: [] },
      'GET /v1/operator/redemptions': { body: [] },
    });
    const r = await w.req('GET', '/api/operator/state');
    expect(r.status).toBe(200);
    expect(r.body.planActive).toBe(false);
    expect(r.body.usage.spinsThisMonth).toBe(3);
    expect(w.calls.find((c) => c.url === '/v1/billing/usage')).toBeDefined();
  });
});

describe('operator credentials, rules and wheel reach the services', () => {
  it('credentials: identity gets platform and environment; the secrets come back once, camelCase', async () => {
    const w = await signedIn({
      'POST /v1/credentials': {
        status: 201,
        body: { key_id: 'k1', api_key: 'a1', hmac_secret: 'h1' },
      },
    });
    const r = await w.req('POST', '/api/operator/credentials', { environment: 'sandbox' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ environment: 'sandbox', keyId: 'k1', apiKey: 'a1', hmacSecret: 'h1' });
    expect(w.calls[0]).toMatchObject({
      url: '/v1/credentials',
      body: { platform: 'casino-a', environment: 'sandbox' },
    });
    expect((await w.req('POST', '/api/operator/credentials', { environment: 'both' })).status).toBe(
      422,
    );
  });

  it('rules: EUR becomes minor units, cap becomes max_grants_per_player, per is dropped', async () => {
    const w = await signedIn({ 'PUT /v1/operator/rules': { body: { id: 'r', version: 2 } } });
    const r = await w.req('POST', '/api/operator/rules', {
      min: 20,
      spins: 1,
      per: true,
      cap: 3,
    });
    expect(r.status).toBe(204);
    expect(w.calls[0]!.body).toEqual({
      name: 'Deposit rule',
      min_amount_minor: 2000,
      currency: 'EUR',
      spins: 1,
      max_grants_per_player: 3,
    });
    expect((await w.req('POST', '/api/operator/rules', { min: 0, spins: 1, cap: 1 })).status).toBe(
      422,
    );
  });

  it('wheel: eight coin segments, weights x10 as integers, each reward the segment coins', async () => {
    const w = await signedIn({ 'PUT /v1/operator/wheel': { body: { id: 'w', version: 2 } } });
    const weights = [30, 24, 18, 12, 8, 5, 2.5, 0.5];
    const r = await w.req('POST', '/api/operator/wheel/publish', { weights });
    expect(r.status).toBe(204);
    const segs = (w.calls[0]!.body as { segments: Array<Record<string, unknown>> }).segments;
    expect(segs).toHaveLength(8);
    expect(segs.map((s) => s.weight)).toEqual([300, 240, 180, 120, 80, 50, 25, 5]);
    expect(segs[7]).toEqual({ label: '5', weight: 5, reward: { type: 'coins', amount: 5 } });
    expect((await w.req('POST', '/api/operator/wheel/publish', { weights: [1, 2] })).status).toBe(
      422,
    );
  });
});
