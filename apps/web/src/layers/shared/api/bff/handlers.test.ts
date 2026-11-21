// BFF tests: the web calls the services through the reconciled contracts (W-1 ... W-12) and keeps every token
// server-side (D-10). Services are a recording fake `fetch`; each test names the mutation that turns it red.
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const TOKEN = (aud: string) => jwt({ sub: U(9), tid: U(8), roles: ['operator_admin'], aud });

type Reply = { status?: number; body?: unknown };
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function world(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      url: u.pathname,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const r = routes[`${call.method} ${u.pathname}`];
    if (!r)
      return new Response(JSON.stringify({ message: 'no route', code: 'nope' }), { status: 404 });
    const reply = typeof r === 'function' ? r(call) : r;
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), { status });
  }) as unknown as typeof fetch;
  const sessions = createMemorySessionStore();
  const config = readBffConfig({
    IDENTITY_URL: 'http://identity',
    PAYMENTS_URL: 'http://payments',
    ENGAGEMENT_URL: 'http://engagement',
  });
  const bff = createBff({ config, sessions, fetch: fetchImpl });
  let cookie = '';
  const req = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await bff.handle(
      new Request(`http://web${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      }),
    );
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : undefined, setCookie: set };
  };
  return { calls, req, sessions };
}

const tokenReply = (aud: string): Reply => ({
  body: { access_token: TOKEN(aud), token_type: 'Bearer', expires_in: 900 },
});
const LOGIN: Record<string, Reply | ((c: Call) => Reply)> = {
  'POST /v1/auth/login': (c) => tokenReply((c.body as { audience: string }).audience),
};

async function signedIn(extra: Record<string, Reply | ((c: Call) => Reply)> = {}) {
  const w = world({ ...LOGIN, ...extra });
  await w.req('POST', '/api/session/login', { email: 'o@x.io', password: 'correct horse' });
  w.calls.length = 0;
  return w;
}

const SPIN = { spin_id: U(1), segment_index: 3, segment_label: '50', reward_coins: 50 };
const ITEM = {
  id: U(2),
  name: '20 free spins',
  description: 'd',
  image_url: null,
  price: 300,
  reward: { type: 'free_spins', params: {} },
  stock: null,
  per_player_limit: null,
  active: true,
  version: 1,
};
const REDEMPTION = {
  id: U(3),
  item_id: U(2),
  price: 300,
  status: 'pending',
  state: 'REQUESTED',
  attempts: 0,
  casino_reference: null,
  failure_reason: null,
  history: [],
  created_at: '2026-11-21T10:00:00.000Z',
  updated_at: '2026-11-21T10:00:00.000Z',
};

describe('session (D-10): tokens stay in the server session', () => {
  it('login sets an HttpOnly cookie and NO token appears in the answer or the cookie', async () => {
    const w = world(LOGIN);
    const r = await w.req('POST', '/api/session/login', {
      email: 'o@x.io',
      password: 'correct horse',
    });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Lax/);
    expect(r.text).not.toMatch(/h\.[A-Za-z0-9_-]+\.s/);
    expect(r.setCookie).not.toMatch(/h\.[A-Za-z0-9_-]+\.s/);
    // one login per service audience: a token is valid for one audience
    expect(w.calls.map((c) => (c.body as { audience: string }).audience).sort()).toEqual([
      'engagement',
      'identity',
      'payments',
    ]);
  });

  it('a call without a session is 401 and reaches no service', async () => {
    const w = world(LOGIN);
    const r = await w.req('GET', '/api/player/state');
    expect(r.status).toBe(401);
    expect(w.calls).toHaveLength(0);
  });

  it('a forged cookie is not a session', async () => {
    const w = world(LOGIN);
    const r = await w.req('GET', '/api/operator/state', undefined, { cookie: 'mio_sid=forged' });
    expect(r.status).toBe(401);
  });
});

describe('W-1 spin: segment_index, segment_label, reward_coins', () => {
  it('maps the service answer and forwards the Idempotency-Key; the balance is not in it', async () => {
    const w = await signedIn({ 'POST /v1/spins': { status: 201, body: SPIN } });
    const r = await w.req('POST', '/api/player/spins', {}, { 'idempotency-key': 'k-1' });
    expect(r.body).toEqual({ id: U(1), index: 3, coins: 50 });
    expect(w.calls[0]!.headers['idempotency-key']).toBe('k-1');
    expect(w.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN('engagement')}`);
  });

  it.each([
    [409, 'no_credit'],
    [409, 'in_progress'],
    [404, 'not_found'],
  ])(
    'a %i %s from the service reaches the browser with its status and code',
    async (status, code) => {
      const w = await signedIn({ 'POST /v1/spins': { status, body: { message: code, code } } });
      const r = await w.req('POST', '/api/player/spins', {}, { 'idempotency-key': 'k-1' });
      expect(r.status).toBe(status);
      expect(r.body.code).toBe(code);
    },
  );

  it('a spin without a key is refused before any service call', async () => {
    const w = await signedIn({ 'POST /v1/spins': { status: 201, body: SPIN } });
    const r = await w.req('POST', '/api/player/spins', {});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('idempotency_key_required');
    expect(w.calls).toHaveLength(0);
  });

  it('a 5xx from the service is a 502 (unknown outcome), never its text', async () => {
    const w = await signedIn({
      'POST /v1/spins': { status: 500, body: { message: 'secret stack' } },
    });
    const r = await w.req('POST', '/api/player/spins', {}, { 'idempotency-key': 'k' });
    expect(r.status).toBe(502);
    expect(r.text).not.toMatch(/secret/);
  });
});

describe('player state: balance from payments, spins from GET /v1/me/spins, items mapped (W-3, W-7, W-5)', () => {
  const routes = {
    'GET /v1/me/balance': { body: { wallet_id: U(5), available: 420, held: 0, currency: 'COIN' } },
    'GET /v1/me/spins': { body: { available: 2 } },
    'GET /v1/store/items': { body: [ITEM, { ...ITEM, id: U(4), stock: 3, active: false }] },
    'GET /v1/me/redemptions': {
      body: [{ ...REDEMPTION, status: 'failed_refunded', state: 'REFUNDED' }],
    },
  };
  it('composes the widget state', async () => {
    const w = await signedIn(routes);
    const r = await w.req('GET', '/api/player/state');
    expect(r.status).toBe(200);
    expect(r.body.coins).toBe(420);
    expect(r.body.spins).toBe(2);
    expect(r.body.store).toEqual([
      { id: U(2), name: '20 free spins', description: 'd', priceCoins: 300, kind: 'free_spins' },
    ]);
    expect(r.body.redemptions).toEqual([
      { id: U(3), itemId: U(2), item: '20 free spins', coins: 300, status: 'failed_refunded' },
    ]);
  });

  it('reads the wallet of payments with the payments token and the spins with the engagement token', async () => {
    const w = await signedIn(routes);
    await w.req('GET', '/api/player/state');
    const auth = (path: string) => w.calls.find((c) => c.url === path)!.headers.authorization;
    expect(auth('/v1/me/balance')).toBe(`Bearer ${TOKEN('payments')}`);
    expect(auth('/v1/me/spins')).toBe(`Bearer ${TOKEN('engagement')}`);
  });

  it('a service answer with the wrong shape is a 502, not a half-filled state', async () => {
    const w = await signedIn({ ...routes, 'GET /v1/me/balance': { body: { available: 'many' } } });
    const r = await w.req('GET', '/api/player/state');
    expect(r.status).toBe(502);
  });
});

describe('W-6 redemption: POST returns 202, 409 insufficient_funds', () => {
  it('202 -> the view with the store status; the key is forwarded; the body is snake_case', async () => {
    const w = await signedIn({
      'POST /v1/redemptions': { status: 202, body: REDEMPTION },
      'GET /v1/store/items': { body: [ITEM] },
    });
    const r = await w.req(
      'POST',
      '/api/player/redemptions',
      { itemId: U(2) },
      { 'idempotency-key': 'k-9' },
    );
    expect(r.status).toBe(202);
    expect(r.body).toEqual({
      id: U(3),
      itemId: U(2),
      item: '20 free spins',
      coins: 300,
      status: 'pending',
    });
    const call = w.calls.find((c) => c.url === '/v1/redemptions')!;
    expect(call.body).toEqual({ item_id: U(2) });
    expect(call.headers['idempotency-key']).toBe('k-9');
  });

  it('409 insufficient_funds reaches the browser as 409 with its code', async () => {
    const w = await signedIn({
      'POST /v1/redemptions': { status: 409, body: { message: 'no', code: 'insufficient_funds' } },
      'GET /v1/store/items': { body: [ITEM] },
    });
    const r = await w.req(
      'POST',
      '/api/player/redemptions',
      { itemId: U(2) },
      { 'idempotency-key': 'k' },
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('insufficient_funds');
  });
});

describe('operator: signup, plans and payment attempts follow L2/L1 (W-9, W-10, W-11)', () => {
  const PLAN = {
    id: U(20),
    code: 'growth',
    name: 'Growth',
    interval: 'month',
    price_minor: 79900,
    currency: 'EUR',
  };
  const ATTEMPT = {
    id: U(21),
    plan_id: U(20),
    subscription_id: null,
    state: 'succeeded',
    card_last4: '4242',
    card_brand: 'visa',
    created_at: '2026-11-21T10:00:00.000Z',
    updated_at: '2026-11-21T10:00:00.000Z',
  };

  it('W-11: signup sends tenant_name, slug, e-mail and password, then opens the session', async () => {
    const w = world({
      ...LOGIN,
      'POST /v1/operators/signup': {
        status: 201,
        body: {
          tenant: {
            id: U(8),
            type: 'operator',
            name: 'Cherry Row Ltd',
            slug: 'cherry-row-ltd',
            status: 'active',
          },
          user: { id: U(9), email: 'o@x.io', roles: ['operator_admin'] },
        },
      },
    });
    const r = await w.req('POST', '/api/operator/account', {
      companyName: 'Cherry Row Ltd',
      email: 'o@x.io',
      password: 'correct horse',
    });
    expect(r.status).toBe(201);
    expect(w.calls[0]!.body).toEqual({
      tenant_name: 'Cherry Row Ltd',
      slug: 'cherry-row-ltd',
      email: 'o@x.io',
      password: 'correct horse',
    });
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect((await w.req('POST', '/api/operator/payments', {})).status).not.toBe(401);
  });

  it('W-9: the attempt gets the plan uuid and the full test card; the view word for succeeded is paid', async () => {
    const w = await signedIn({
      'GET /v1/billing/plans': { body: [PLAN] },
      'POST /v1/billing/attempts': { status: 201, body: ATTEMPT },
    });
    const r = await w.req(
      'POST',
      '/api/operator/payments',
      { planId: 'growth', last4: '4242', cardNumber: '4242 4242 4242 4242' },
      { 'idempotency-key': 'k-p' },
    );
    expect(r.body).toEqual({
      id: U(21),
      plan: 'growth',
      amount: 799,
      last4: '4242',
      status: 'paid',
    });
    const call = w.calls.find((c) => c.url === '/v1/billing/attempts')!;
    expect(call.body).toEqual({ plan_id: U(20), card_number: '4242424242424242' });
    expect(call.headers['idempotency-key']).toBe('k-p');
  });

  it('W-9: cancel forwards the Idempotency-Key (L2 answers 400 without it)', async () => {
    const w = await signedIn({
      [`POST /v1/billing/attempts/${U(21)}/cancel`]: { status: 200, body: {} },
    });
    const r = await w.req(
      'POST',
      `/api/operator/payments/${U(21)}/cancel`,
      {},
      { 'idempotency-key': 'k-c' },
    );
    expect(r.status).toBe(204);
    expect(w.calls[0]!.headers['idempotency-key']).toBe('k-c');
    const none = await w.req('POST', `/api/operator/payments/${U(21)}/cancel`, {});
    expect(none.status).toBe(400);
  });

  it('W-10: plans are in major units, usage uses L2 names', async () => {
    const w = await signedIn({
      'GET /v1/billing/plans': { body: [PLAN] },
      'GET /v1/billing/subscription': { status: 404, body: { message: 'none', code: 'not_found' } },
      'GET /v1/billing/invoices': { body: [] },
      'GET /v1/billing/usage': {
        body: { period: '2026-11', spins: 980, monthly_active_players: 41 },
      },
      'GET /v1/store/items': { body: [ITEM] },
      'GET /v1/operator/redemptions': { body: [REDEMPTION] },
    });
    const r = await w.req('GET', '/api/operator/state');
    expect(r.status).toBe(200);
    expect(r.body.plans).toEqual([
      { id: 'growth', name: 'Growth', price: 799, spins: '', extra: '' },
    ]);
    expect(r.body.usage).toMatchObject({ spinsThisMonth: 980, activePlayers: 41 });
    expect(r.body.planActive).toBe(false);
    expect(r.body.catalog[0]).toMatchObject({ id: U(2), priceCoins: 300, visible: true });
    expect(r.body.redemptions[0]).toMatchObject({ item: '20 free spins', status: 'pending' });
  });
});

describe('W-12 acting: the token stays in the BFF session', () => {
  const ACTING_ROUTES = {
    'POST /v1/auth/acting': (c: Call) =>
      tokenReply(`acting-${(c.body as { audience: string }).audience}`),
    'GET /v1/billing/plans': { body: [] },
    'GET /v1/billing/subscription': { status: 404, body: { message: 'x', code: 'not_found' } },
    'GET /v1/billing/invoices': { body: [] },
    'GET /v1/billing/usage': { status: 404, body: { message: 'x', code: 'not_found' } },
    'GET /v1/store/items': { body: [] },
    'GET /v1/operator/redemptions': { body: [] },
  };

  it('sends snake_case tenant_id/reason per audience, answers without a token, then uses it for the operator reads', async () => {
    const w = await signedIn(ACTING_ROUTES);
    const r = await w.req('POST', '/api/platform/act-as', {
      tenantId: U(30),
      reason: 'Support ticket 1042',
    });
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
    const acting = w.calls.filter((c) => c.url === '/v1/auth/acting');
    expect(acting.map((c) => c.body)).toEqual(
      ['identity', 'engagement', 'payments'].map((audience) => ({
        tenant_id: U(30),
        reason: 'Support ticket 1042',
        audience,
      })),
    );
    // the identity call carries the admin's own token, not an acting one
    expect(acting[0]!.headers.authorization).toBe(`Bearer ${TOKEN('identity')}`);

    w.calls.length = 0;
    await w.req('GET', '/api/operator/state');
    const auth = (path: string) => w.calls.find((c) => c.url === path)!.headers.authorization;
    expect(auth('/v1/billing/plans')).toBe(`Bearer ${jwtOf('acting-payments')}`);
    expect(auth('/v1/store/items')).toBe(`Bearer ${jwtOf('acting-engagement')}`);
  });

  it('a short reason is refused (D-15 Q-4) before identity is called', async () => {
    const w = await signedIn(ACTING_ROUTES);
    const r = await w.req('POST', '/api/platform/act-as', { tenantId: U(30), reason: 'x' });
    expect(r.status).toBe(422);
    expect(w.calls).toHaveLength(0);
  });

  it('an expired acting grant is dropped and the session goes back to its own tokens', async () => {
    let now = 1_000_000;
    const sessions = createMemorySessionStore();
    const s = sessions.create({
      kind: 'operator',
      tenantId: U(8),
      userId: U(9),
      roles: ['platform_admin'],
      tokens: { payments: { token: 'own', expiresAt: now + 900_000 } },
      acting: {
        tenantId: U(30),
        tokens: { payments: { token: 'acting', expiresAt: now + 10_000 } },
      },
      attemptId: null,
      lastSpin: null,
      casinoDown: false,
    });
    const { bearerFor } = await import('./session');
    expect(bearerFor(s, 'payments', now)).toBe('acting');
    now += 20_000;
    expect(bearerFor(s, 'payments', now)).toBe('own');
    expect(s.acting).toBeNull();
  });
});

// The acting token minted by the fake is `h.<claims>.s` with aud `acting-<audience>`.
function jwtOf(aud: string) {
  return TOKEN(aud);
}

describe('D-10 realtime ticket through the BFF', () => {
  it('fetches the ticket with the session and returns only the ticket', async () => {
    const w = await signedIn({
      'POST /v1/auth/realtime-ticket': { body: { ticket: 'tkt-1', expires_in: 60 } },
    });
    const r = await w.req('GET', '/api/realtime/ticket');
    expect(r.body).toEqual({ ticket: 'tkt-1', expiresIn: 60 });
    expect(r.text).not.toContain(TOKEN('identity'));
  });

  it('no session, no ticket', async () => {
    const w = world(LOGIN);
    expect((await w.req('GET', '/api/realtime/ticket')).status).toBe(401);
  });
});

describe('player launch exchange', () => {
  it('asks the engagement and payments audiences and keeps both tokens server-side', async () => {
    const w = world({
      'POST /v1/auth/launch': (c) => ({
        body: {
          ...(tokenReply((c.body as { audience: string }).audience).body as object),
          user_id: U(40),
          tenant_id: U(8),
        },
      }),
    });
    const r = await w.req('POST', '/api/session/launch', { token: 'x'.repeat(40) });
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/h\.[A-Za-z0-9_-]+\.s/);
    expect(w.calls.map((c) => (c.body as { audience: string }).audience)).toEqual([
      'engagement',
      'payments',
    ]);
  });
});
