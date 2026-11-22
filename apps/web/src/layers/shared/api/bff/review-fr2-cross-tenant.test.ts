// Fix round 2 re-review, item 7: the web-live merge (44039f8) added BFF routes (credentials, catalog,
// rules, wheel, the payment-provider stand-in) and made the BFF forward a `Host`. None of them may let
// a browser pick the tenant: the tenant is the session's, carried by the session's service tokens.
//
// FR2-BFF-1: operator A's session, with tenant B named every way a browser can (query, `x-tenant-id`,
//   `x-forwarded-host` and `Host` of B's subdomain, body `tenant_id`/`tenantId`), reads the operator
//   state and issues a credential. Every upstream call carries A's token, and B's id or host reaches no
//   upstream URL, header or body. Mutation: in `hostHeader`, forward the browser host on every call
//   (not only the login), or take `ctx.body.tenantId` into the credential body -> red.
// FR2-BFF-2: a request without a session cookie reaches no upstream at all (401 first).
//   Mutation: drop `need(ctx.session)` from the credentials route -> red.
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const A = '0190a1b2-c3d4-7e5f-8a6b-00000000000a';
const B = '0190a1b2-c3d4-7e5f-8a6b-00000000000b';
const B_HOST = 'tenant-b.mio.localhost';
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

interface Call {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

function world() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url: `${u.pathname}${u.search}`, body: String(init.body ?? ''), headers });
    if (method === 'POST' && u.pathname === '/v1/auth/login') {
      const aud = (JSON.parse(String(init.body)) as { audience: string }).audience;
      return new Response(
        JSON.stringify({
          access_token: jwt({ sub: 'op-a', tid: A, roles: ['operator_admin'], aud }),
          token_type: 'Bearer',
          expires_in: 900,
        }),
        { status: 200 },
      );
    }
    if (method === 'POST' && u.pathname === '/v1/credentials') {
      return new Response(
        JSON.stringify({
          key_id: 'k1',
          api_key: 'ak',
          hmac_secret: 'hs',
          platform: 'casino-a',
          environment: 'sandbox',
        }),
        { status: 201 },
      );
    }
    return new Response('[]', { status: 200 });
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
  const req = async (
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const res = await bff.handle(
      new Request(`http://web${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res.status;
  };
  return { calls, req, dropCookie: () => (cookie = '') };
}

const tokenTenant = (auth: string | undefined): string | undefined => {
  if (!auth?.startsWith('Bearer ')) return undefined;
  const payload = auth.slice('Bearer '.length).split('.')[1]!;
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { tid: string }).tid;
};

describe('fix round 2: the BFF never lets the browser pick the tenant', () => {
  it('FR2-BFF-1 operator A naming tenant B every way reaches only A, with A tokens', async () => {
    const w = world();
    expect(
      await w.req('POST', '/api/session/login', { email: 'o@a.example', password: 'pw-correct' }),
    ).toBe(200);
    w.calls.length = 0;
    const hints = { 'x-tenant-id': B, 'x-forwarded-host': B_HOST, host: B_HOST };
    await w.req('GET', `/api/operator/state?tenantId=${B}&tenant_id=${B}`, undefined, hints);
    const issued = await w.req(
      'POST',
      '/api/operator/credentials',
      { environment: 'sandbox', tenant_id: B, tenantId: B },
      hints,
    );
    expect(issued).toBe(201);
    // the control: the reads and the write did reach the services
    expect(w.calls.some((c) => c.url.startsWith('/v1/billing/plans'))).toBe(true);
    expect(w.calls.some((c) => c.url === '/v1/credentials')).toBe(true);
    const leaks = w.calls.filter(
      (c) =>
        tokenTenant(c.headers.authorization) !== A ||
        `${c.url} ${c.body} ${JSON.stringify(c.headers)}`.includes(B) ||
        JSON.stringify(c.headers).includes(B_HOST),
    );
    expect(leaks.map((c) => `${c.method} ${c.url}`)).toEqual([]);
  });

  it('FR2-BFF-2 without a session no upstream is called', async () => {
    const w = world();
    expect(await w.req('POST', '/api/operator/credentials', { environment: 'sandbox' })).toBe(401);
    expect(await w.req('GET', '/api/operator/state')).toBe(401);
    expect(await w.req('POST', '/api/operator/rules', { min: 20, spins: 1, cap: 3 })).toBe(401);
    expect(w.calls).toEqual([]);
  });
});
