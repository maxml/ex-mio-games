import { request } from 'node:http';
import type { Client } from 'pg';
import {
  accessClaims,
  generateRsaKey,
  signJwt,
  signLaunchToken,
} from '@ex-mio/service-kit/testing';
import {
  CredentialIssued,
  INTERNAL_ROUTES,
  InternalResolvePlayerResponse,
  JwksResponse,
  LaunchResponse,
  PLATFORM_TENANT_ID,
  uuidv7,
} from '@ex-mio/contracts';
import { eventually, pgAs, platformAdmin, serviceSecrets, urls } from './env';

/*
 * Database and cross-service twins of the identity invariants (docs/specs/identity.md,
 * "Compose tests"). They need the migrated identity schema and the running stack.
 * RED today: the tables do not exist, the JWKS route does not exist.
 *
 * Every DB test runs in a transaction that is rolled back, so the shared
 * database is left as it was found.
 */

const TENANT_TABLES = [
  'users',
  'user_roles',
  'provider_links',
  'player_links',
  'launch_jti',
  'integration_credentials',
  'audit_log',
];

async function inTx<T>(tenantId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pgAs('identity');
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

const insertTenant = (c: Client, id: string, type: string, slug: string) =>
  c.query(`INSERT INTO tenants (id, type, name, slug, status) VALUES ($1, $2, $3, $4, 'active')`, [
    id,
    type,
    slug,
    slug,
  ]);
const insertUser = (c: Client, tenantId: string, id: string, email: string) =>
  c.query(`INSERT INTO users (tenant_id, id, email, kind) VALUES ($1, $2, $3, 'staff')`, [
    tenantId,
    id,
    email,
  ]);

describe('INV-DB: identity schema enforces the invariants even if the application forgets', () => {
  // Mutation: drop the partial unique index on tenants(type) WHERE type = 'platform'.
  it('INV-DB-1 the platform tenant is seeded and a second platform tenant violates a unique index', async () => {
    await inTx(null, async (c) => {
      const seeded = await c.query(
        `SELECT count(*)::int AS n, min(id::text) AS id FROM tenants WHERE type = 'platform'`,
      );
      expect(seeded.rows[0].n).toBe(1);
      expect(seeded.rows[0].id).toBe(PLATFORM_TENANT_ID); // the verifier binds platform_admin to this id (F8)
      await expect(insertTenant(c, uuidv7(), 'platform', `p-${uuidv7()}`)).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  // Mutation: make the unique key (email) instead of (tenant_id, email).
  it('INV-DB-2 the same email is unique within a tenant and free in another tenant', async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    await inTx(a, async (c) => {
      await insertTenant(c, a, 'operator', `a-${a}`);
      await insertTenant(c, b, 'operator', `b-${b}`);
      await insertUser(c, a, uuidv7(), 'dup@x.test');
      await expect(insertUser(c, a, uuidv7(), 'dup@x.test')).rejects.toMatchObject({
        code: '23505',
      });
    });
    await inTx(null, async (c) => {
      await insertTenant(c, a, 'operator', `a-${a}`);
      await insertTenant(c, b, 'operator', `b-${b}`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a]);
      await insertUser(c, a, uuidv7(), 'dup@x.test');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [b]);
      await expect(insertUser(c, b, uuidv7(), 'dup@x.test')).resolves.toBeDefined();
    });
  });

  // Mutation: drop either UNIQUE on player_links (backlog MIO-044 mapping contract).
  it('INV-DB-3 player_links: one user per (tenant, platform, external id) and one link per user', async () => {
    const a = uuidv7();
    await inTx(a, async (c) => {
      await insertTenant(c, a, 'operator', `a-${a}`);
      const [u1, u2] = [uuidv7(), uuidv7()];
      await c.query(
        `INSERT INTO users (tenant_id, id, email, kind) VALUES ($1, $2, NULL, 'player'), ($1, $3, NULL, 'player')`,
        [a, u1, u2],
      );
      const link = (user: string, platform: string, ext: string) =>
        c.query(
          `INSERT INTO player_links (tenant_id, user_id, platform, external_player_id) VALUES ($1, $2, $3, $4)`,
          [a, user, platform, ext],
        );
      await link(u1, 'sim-casino', 'ext-1');
      await c.query('SAVEPOINT s1');
      await expect(link(u2, 'sim-casino', 'ext-1')).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK TO s1');
      await expect(link(u1, 'other-casino', 'ext-2')).rejects.toMatchObject({ code: '23505' });
    });
  });

  // Mutation: drop the primary key on launch_jti.
  it('INV-DB-4 a launch nonce can be stored once per tenant', async () => {
    const a = uuidv7();
    await inTx(a, async (c) => {
      await insertTenant(c, a, 'operator', `a-${a}`);
      const put = () =>
        c.query(
          `INSERT INTO launch_jti (tenant_id, jti, expires_at) VALUES ($1, 'nonce-1', now() + interval '5 minutes')`,
          [a],
        );
      await put();
      await expect(put()).rejects.toMatchObject({ code: '23505' });
    });
  });

  // Mutation: NO FORCE / drop WITH CHECK / forget a new table (the catalog check goes red).
  it('INV-DB-5 every table with a tenant_id column has RLS enabled, forced, with a policy that has WITH CHECK (bus tables excepted)', async () => {
    {
      const identityDb = await pgAs('identity');
      try {
        const missing = await identityDb.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                  (SELECT bool_and(p.with_check IS NOT NULL) FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public') AS with_check
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE c.relkind = 'r'
              AND c.relname NOT IN ('outbox', 'inbox')
              AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'tenant_id')
              AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND COALESCE((SELECT bool_and(p.with_check IS NOT NULL) FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public'), false))`,
        );
        expect(missing.rows).toEqual([]);
        const present = await identityDb.query(
          `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`,
          [TENANT_TABLES],
        );
        expect(present.rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
      } finally {
        await identityDb.end();
      }
    }
  });

  // F9. Mutation: grant BYPASSRLS to the identity role, or forget FORCE / SET LOCAL. The previous
  // version read an empty table on a fresh stack (green with BYPASSRLS granted) and accepted a
  // foreign-key error for the write. Here a row EXISTS and is visible with the tenant set, so
  // "zero rows" after clearing the setting can only be the policy.
  it('INV-DB-6 a row visible with the tenant set is invisible without it, in every tenant table; a write without it is refused by RLS (42501)', async () => {
    const a = uuidv7();
    await inTx(a, async (c) => {
      await insertTenant(c, a, 'operator', `a-${a}`);
      const userId = uuidv7();
      await insertUser(c, a, userId, 'seen@x.test');
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role) VALUES ($1, $2, 'operator_admin')`,
        [a, userId],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, id, actor_user_id, actor_tenant_id, acting_tenant_id, action, reason)
         VALUES ($1, $2, $3, $1, $1, 'tenant.read', 'seed')`,
        [a, uuidv7(), userId],
      );
      const count = async (table: string) =>
        (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
      expect({ users: await count('users') }).toEqual({ users: 1 }); // visible with the tenant set
      expect({ user_roles: await count('user_roles') }).toEqual({ user_roles: 1 });
      await c.query(`SELECT set_config('app.tenant_id', '', true)`);
      for (const table of TENANT_TABLES) {
        expect({ table, n: await count(table) }).toEqual({ table, n: 0 });
      }
      await c.query('SAVEPOINT w');
      await expect(
        insertUser(c, a, uuidv7(), 'blocked@x.test'), // tenant `a` EXISTS: the only thing in the way is RLS
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/row-level security/),
      });
      await c.query('ROLLBACK TO w');
    });
  });

  // Mutation: use a single-column FK on player_links.user_id.
  it('INV-DB-7 a link in tenant A cannot point at a user of tenant B (composite foreign key)', async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    await inTx(null, async (c) => {
      await insertTenant(c, a, 'operator', `a-${a}`);
      await insertTenant(c, b, 'operator', `b-${b}`);
      const ub = uuidv7();
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [b]);
      await c.query(
        `INSERT INTO users (tenant_id, id, email, kind) VALUES ($1, $2, NULL, 'player')`,
        [b, ub],
      );
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a]);
      await expect(
        c.query(
          `INSERT INTO player_links (tenant_id, user_id, platform, external_player_id) VALUES ($1, $2, 'sim-casino', 'ext-1')`,
          [a, ub],
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|42501)$/) });
    });
  });
});

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers });

const postWithHost = (
  path: string,
  host: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> =>
  new Promise((resolve, reject) => {
    const u = new URL(`${urls.identity}${path}`);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: { host, 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

describe('INV-STACK: identity token is the only way into the other services', () => {
  // Mutation: remove the JWKS route or serve it behind the guard.
  it('INV-STACK-1 identity serves its JWKS publicly and without private members', async () => {
    const res = await get(`${urls.identity}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = JwksResponse.parse(await res.json());
    expect(JSON.stringify(body)).not.toMatch(/"(d|p|q|dp|dq|qi)":/);
  });

  // Mutation: restore the header placeholder in the service-kit bootstrap of any service.
  it.each([
    ['engagement', `${urls.engagement}/v1/tenant-projection`],
    ['payments', `${urls.payments}/v1/credits`],
  ])('INV-STACK-2 %s refuses x-tenant-id without a token (401)', async (_name, url) => {
    expect((await get(url, { 'x-tenant-id': uuidv7() })).status).toBe(401);
  });

  // Mutation: verify with a key fetched from anywhere but identity's JWKS.
  it('INV-STACK-3 a token for audience engagement is accepted by engagement and refused by payments', async () => {
    const slug = `t${Date.now().toString(36)}`;
    const email = `boss@${slug}.test`;
    const password = 'correct horse battery';
    const signup = await postWithHost('/v1/operators/signup', 'localhost', {
      tenant_name: slug,
      slug,
      email,
      password,
    });
    expect(signup.status).toBe(201);
    const login = await postWithHost('/v1/auth/login', `${slug}.mio.localhost`, {
      email,
      password,
      audience: 'engagement',
    });
    expect(login.status).toBe(200);
    const token = (login.json as { access_token: string }).access_token;
    const headers = { authorization: `Bearer ${token}` };
    // F13: exactly 200 (a 500 is not "accepted"); the projection arrives over the bus, so wait for it.
    await eventually(async () =>
      (await get(`${urls.engagement}/v1/tenant-projection`, headers)).status === 200
        ? true
        : undefined,
    );
    expect((await get(`${urls.payments}/v1/credits`, headers)).status).toBe(401);
  });
});

interface Http {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Any method, optional Host and headers, JSON in and out. */
const call = (
  method: 'GET' | 'POST',
  base: string,
  path: string,
  opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Http> =>
  new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body ? JSON.stringify(opts.body) : undefined);
  });

const PW = 'correct horse battery';
const uniq = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Signs up an operator through the stack and returns who it is and a token for `audience`. */
async function operator(
  audience: 'identity' | 'engagement' | 'payments',
  email?: string,
  password = PW,
) {
  const slug = uniq();
  const mail = email ?? `boss@${slug}.test`;
  const signup = await call('POST', urls.identity, '/v1/operators/signup', {
    host: 'localhost',
    body: { tenant_name: slug, slug, email: mail, password },
  });
  expect(signup.status).toBe(201);
  const login = (aud: string) =>
    call('POST', urls.identity, '/v1/auth/login', {
      host: `${slug}.mio.localhost`,
      body: { email: mail, password, audience: aud },
    });
  const res = await login(audience);
  expect(res.status).toBe(200);
  return {
    slug,
    email: mail,
    tenantId: signup.json.tenant.id as string,
    token: res.json.access_token as string,
    login,
  };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('INV-STACK-2b / 4: engagement and payments take the tenant from the token only (F2, F13)', () => {
  // Mutation: any service reads x-tenant-id (or passes its own resolver) next to the token.
  it('INV-STACK-2b token for A + x-tenant-id: B is served as A, in engagement and in payments', async () => {
    const a = await operator('payments');
    const b = await operator('payments');
    const aEng = (await a.login('engagement')).json.access_token as string;
    // engagement: the projection that comes back is A's, not the header's B
    const projection = await eventually(async () => {
      const r = await get(`${urls.engagement}/v1/tenant-projection`, {
        ...bearer(aEng),
        'x-tenant-id': b.tenantId,
      });
      return r.status === 200 ? ((await r.json()) as { tenant_id: string }) : undefined;
    });
    expect(projection.tenant_id).toBe(a.tenantId);
    // payments, on a route with NO coin effect (D-14 / N4: no operator mints coins): rows seeded
    // through the payments DB role for A and for B; a token for A with a header naming B lists A's only.
    const [playerA, playerB] = [uuidv7(), uuidv7()];
    const seeded: Array<[string, string]> = [
      [a.tenantId, playerA],
      [b.tenantId, playerB],
    ];
    const seed = async (tenantId: string, player: string) => {
      const c = await pgAs('payments');
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await c.query(
          `INSERT INTO coin_credits (id, tenant_id, player_id, amount) VALUES ($1, $2, $3, 5)`,
          [uuidv7(), tenantId, player],
        );
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
    };
    const unseed = async (tenantId: string, player: string) => {
      const c = await pgAs('payments');
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        await c.query(`DELETE FROM coin_credits WHERE player_id = $1`, [player]);
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
    };
    try {
      for (const [tenantId, player] of seeded) await seed(tenantId, player);
      const asA = await call('GET', urls.payments, '/v1/credits', {
        headers: { ...bearer(a.token), 'x-tenant-id': b.tenantId },
      });
      expect(asA.status).toBe(200);
      expect((asA.json as Array<{ player_id: string }>).map((c) => c.player_id)).toEqual([playerA]);
      const asB = await call('GET', urls.payments, '/v1/credits', {
        headers: { ...bearer(b.token), 'x-tenant-id': a.tenantId },
      });
      expect((asB.json as Array<{ player_id: string }>).map((c) => c.player_id)).toEqual([playerB]);
    } finally {
      for (const [tenantId, player] of seeded) await unseed(tenantId, player).catch(() => undefined);
    }
  });

  // D-14 / N4, the inverted half: the operator's own token cannot mint through the public route.
  // Mutation: serve coins.credit to an operator token (any role) at the real payments service.
  it('INV-STACK-2c an operator_admin token on POST /v1/credits is 403 FORBIDDEN and nothing is stored', async () => {
    const a = await operator('payments');
    const player = uuidv7();
    const made = await call('POST', urls.payments, '/v1/credits', {
      headers: { ...bearer(a.token), 'idempotency-key': `key-${uniq()}` },
      body: { player_id: player, amount: 5 },
    });
    expect(made.status).toBe(403);
    expect(made.json).toMatchObject({ code: 'FORBIDDEN' });
    const c = await pgAs('payments');
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      const rows = await c.query(`SELECT count(*)::int AS n FROM coin_credits WHERE player_id = $1`, [
        player,
      ]);
      expect(rows.rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  // Mutation: any service accepts a well-formed token without checking the signature against identity's JWKS.
  it.each([
    ['engagement', `${urls.engagement}/v1/tenant-projection`],
    ['payments', `${urls.payments}/v1/credits`],
  ])(
    'INV-STACK-4 a token signed by a key identity does not publish is 401 at %s',
    async (name, url) => {
      const stranger = generateRsaKey('k1');
      const now = Math.floor(Date.now() / 1000);
      for (const kid of ['k1', 'unknown-kid']) {
        const forged = signJwt({
          alg: 'RS256',
          key: stranger.privateKey,
          kid,
          claims: accessClaims({ now, sub: uuidv7(), tid: uuidv7(), aud: name, ttl: 600 }),
        });
        expect((await get(url, bearer(forged))).status).toBe(401);
      }
      const unsigned = signJwt({
        alg: 'none',
        kid: 'k1',
        claims: accessClaims({ now, sub: uuidv7(), tid: uuidv7(), aud: name, ttl: 600 }),
      });
      expect((await get(url, bearer(unsigned))).status).toBe(401);
    },
  );
});

describe('INV-STACK-5 service-to-service tokens over the real stack (D-4)', () => {
  const serviceToken = async (who: 'engagement' | 'payments', audience = 'identity') =>
    call('POST', urls.identity, '/v1/auth/service-token', {
      body: { client_id: who, client_secret: serviceSecrets[who], audience },
    });

  // Mutation: identity stops issuing service tokens, or serves /internal/v1 to user tokens.
  it('a service token reads the tenant status of a tenant; a user token on the same route is 401', async () => {
    const a = await operator('identity');
    const svc = await serviceToken('engagement');
    expect(svc.status).toBe(200);
    const url = INTERNAL_ROUTES.tenantStatus.replace(':tenantId', a.tenantId);
    const ok = await call('GET', urls.identity, url, { headers: bearer(svc.json.access_token) });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ tenant_id: a.tenantId, status: 'active' });
    expect((await call('GET', urls.identity, url, { headers: bearer(a.token) })).status).toBe(401);
  });

  // Mutation: a service token is accepted on a user route of another service.
  it('a service token is refused on the user routes of engagement and payments', async () => {
    const forPayments = await serviceToken('engagement', 'payments');
    expect(forPayments.status).toBe(200);
    expect(
      (await get(`${urls.payments}/v1/credits`, bearer(forPayments.json.access_token))).status,
    ).toBe(401);
    const forEngagement = await serviceToken('payments', 'engagement');
    expect(
      (
        await get(
          `${urls.engagement}/v1/tenant-projection`,
          bearer(forEngagement.json.access_token),
        )
      ).status,
    ).toBe(401);
  });

  // Mutation: accept any secret.
  it('a wrong client secret is 401 INVALID_SERVICE_CREDENTIALS', async () => {
    const res = await call('POST', urls.identity, '/v1/auth/service-token', {
      body: { client_id: 'engagement', client_secret: 'x'.repeat(30), audience: 'identity' },
    });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ code: 'INVALID_SERVICE_CREDENTIALS' });
  });

  // Mutation: a service token with another audience is accepted by identity's internal routes.
  it('a service token minted for payments is refused by identity internal routes', async () => {
    const a = await operator('identity');
    const forPayments = await serviceToken('engagement', 'payments');
    const url = INTERNAL_ROUTES.tenantStatus.replace(':tenantId', a.tenantId);
    expect(
      (await call('GET', urls.identity, url, { headers: bearer(forPayments.json.access_token) }))
        .status,
    ).toBe(401);
  });

  // D-14 over the real stack. Mutation: issue any audience to any client, or skip the callee allow-list.
  it('payments cannot get a token for engagement; payments with an identity token is 403 on resolve (status only)', async () => {
    const a = await operator('identity');
    const denied = await serviceToken('payments', 'engagement');
    expect(denied.status).toBe(401);
    expect(denied.json).toMatchObject({ code: 'INVALID_SERVICE_CREDENTIALS' });
    const asPayments = await serviceToken('payments', 'identity');
    expect(asPayments.status).toBe(200);
    const resolve = await call(
      'POST',
      urls.identity,
      INTERNAL_ROUTES.resolvePlayer.replace(':tenantId', a.tenantId),
      {
        headers: bearer(asPayments.json.access_token),
        body: { platform: 'sim-casino', external_player_id: 'ext-1' },
      },
    );
    expect(resolve.status).toBe(403);
    expect(resolve.json).toMatchObject({ code: 'SERVICE_CALL_FORBIDDEN' });
  });

  // N2 over the real stack (Fastify, real routing). Mutation: raw-URL prefix check in any service.
  it('an operator token on /%69nternal/v1/... is never served by identity', async () => {
    const a = await operator('identity');
    const b = await operator('identity');
    const res = await call(
      'GET',
      urls.identity,
      `/%69nternal/v1/tenants/${b.tenantId}/status`,
      { headers: bearer(a.token) },
    );
    expect([401, 404]).toContain(res.status);
  });
});

// D-11 / D-14 over the real stack: the entry points of engagement and payments write the audit
// events to their outboxes; identity consumes them into the audit log the operator reads.
describe('INV-STACK-8 acting requests in other services reach the operator audit log (D-11)', () => {
  // Mutation: the entry point of engagement or payments writes no event, or identity does not consume it.
  it('an acting token on engagement GET /v1/tenant-projection (allowed) and payments POST /v1/credits (refused) shows both in GET /v1/audit', async () => {
    const op = await operator('identity');
    const root = await call('POST', urls.identity, '/v1/auth/login', {
      host: platformAdmin.host,
      body: { email: platformAdmin.email, password: platformAdmin.password, audience: 'identity' },
    });
    expect(root.status).toBe(200);
    const acting = (aud: string) =>
      call('POST', urls.identity, '/v1/auth/acting', {
        headers: bearer(root.json.access_token),
        body: { tenant_id: op.tenantId, reason: 'ticket 42', audience: aud },
      });
    const forEngagement = await acting('engagement');
    const forPayments = await acting('payments');
    expect(forEngagement.status).toBe(200);
    expect(forPayments.status).toBe(200);
    await eventually(async () =>
      (
        await get(`${urls.engagement}/v1/tenant-projection`, bearer(forEngagement.json.access_token))
      ).status === 200
        ? true
        : undefined,
    );
    const refused = await call('POST', urls.payments, '/v1/credits', {
      headers: { ...bearer(forPayments.json.access_token), 'idempotency-key': `key-${uniq()}` },
      body: { player_id: uuidv7(), amount: 5 },
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: 'ACTING_FORBIDDEN' });
    const rows = await eventually(async () => {
      const r = await call('GET', urls.identity, '/v1/audit', { headers: bearer(op.token) });
      const list = (r.json as Array<Record<string, unknown>>).filter(
        (e) => e.action === 'acting.request',
      );
      return list.length >= 2 ? list : undefined;
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: 'engagement',
          route: 'GET /v1/tenant-projection',
          decision: 'allowed',
        }),
        expect.objectContaining({
          service: 'payments',
          route: 'POST /v1/credits',
          decision: 'refused',
        }),
      ]),
    );
  });
});

describe('INV-STACK-6 launch and player mapping hold under real concurrency (F16, MIO-044)', () => {
  const launchToken = (keyId: string, secret: string, ext: string, jti?: string) =>
    signLaunchToken({
      keyId,
      secret,
      now: Math.floor(Date.now() / 1000),
      externalPlayerId: ext,
      ...(jti ? { jti } : {}),
    });

  async function withKey() {
    const a = await operator('identity');
    const issued = await call('POST', urls.identity, '/v1/credentials', {
      headers: bearer(a.token),
      body: { platform: 'sim-casino' },
    });
    expect(issued.status).toBe(201);
    return { a, key: CredentialIssued.parse(issued.json) };
  }

  // Mutation: the jti check is read-then-write without the unique key, or the 23505 is not mapped.
  it('five parallel launches of one token: one 200, four 401 LAUNCH_TOKEN_REPLAYED', async () => {
    const { key } = await withKey();
    const token = launchToken(key.key_id, key.hmac_secret, 'ext-1');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('POST', urls.identity, '/v1/auth/launch', { body: { token, audience: 'engagement' } }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    // F14 / N7: the winning response is the contract shape L5 builds against
    expect(LaunchResponse.parse(results.find((r) => r.status === 200)?.json).tenant_id).toBeDefined();
    const rest = results.filter((r) => r.status !== 200);
    expect(rest.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    for (const r of rest) expect(r.json).toMatchObject({ code: 'LAUNCH_TOKEN_REPLAYED' });
  });

  // Mutation: drop the UNIQUE on player_links / check-then-insert in resolveOrCreate.
  it('parallel launches (different nonces) and internal resolves for one external id make one link and one user', async () => {
    const { a, key } = await withKey();
    const svc = (
      await call('POST', urls.identity, '/v1/auth/service-token', {
        body: {
          client_id: 'engagement',
          client_secret: serviceSecrets.engagement,
          audience: 'identity',
        },
      })
    ).json.access_token as string;
    const launches = Array.from({ length: 4 }, (_, i) =>
      call('POST', urls.identity, '/v1/auth/launch', {
        body: {
          token: launchToken(key.key_id, key.hmac_secret, 'ext-9', `nonce-par-${uniq()}-${i}`),
          audience: 'engagement',
        },
      }),
    );
    const resolves = Array.from({ length: 4 }, () =>
      call('POST', urls.identity, INTERNAL_ROUTES.resolvePlayer.replace(':tenantId', a.tenantId), {
        headers: bearer(svc),
        body: { platform: 'sim-casino', external_player_id: 'ext-9' },
      }),
    );
    const all = await Promise.all([...launches, ...resolves]);
    for (const r of all) expect(r.status).toBe(200);
    const users = new Set([
      ...all.slice(0, 4).map((r) => r.json.user_id as string),
      ...all.slice(4).map((r) => InternalResolvePlayerResponse.parse(r.json).user_id),
    ]);
    expect(users.size).toBe(1);
    const links = await inTx(a.tenantId, (c) =>
      c.query(`SELECT count(*)::int AS n FROM player_links WHERE external_player_id = 'ext-9'`),
    );
    expect(links.rows[0].n).toBe(1);
  });
});

describe('INV-STACK-7 Firebase emulator multi-tenancy (D-7, Q4): the same email in two tenants is two accounts', () => {
  // Mutation: one provider namespace for all tenants (a plain project), or a global email namespace.
  it('registers the same email in two tenants with different passwords; each logs in only to its own tenant', async () => {
    const email = `shared-${uniq()}@x.test`;
    const a = await operator('identity', email, 'password-for-tenant-a');
    const b = await operator('identity', email, 'password-for-tenant-b');
    expect(a.tenantId).not.toBe(b.tenantId);
    const login = (slug: string, password: string) =>
      call('POST', urls.identity, '/v1/auth/login', {
        host: `${slug}.mio.localhost`,
        body: { email, password, audience: 'web' },
      });
    expect((await login(a.slug, 'password-for-tenant-a')).status).toBe(200);
    expect((await login(b.slug, 'password-for-tenant-b')).status).toBe(200);
    expect((await login(a.slug, 'password-for-tenant-b')).status).toBe(401);
    expect((await login(b.slug, 'password-for-tenant-a')).status).toBe(401);
  });

  // Mutation: stop creating one Identity Platform tenant per MIO tenant (createTenant skipped).
  it('the emulator holds one Identity Platform tenant per MIO tenant', async () => {
    const list = async () => {
      const res = await fetch(
        `${urls.firebaseAuth}/identitytoolkit.googleapis.com/v2/projects/demo-ex-mio/tenants?pageSize=1000`,
        { headers: { authorization: 'Bearer owner' } },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { tenants?: unknown[] }).tenants?.length ?? 0;
    };
    const before = await list();
    await operator('identity');
    await operator('identity');
    expect(await list()).toBe(before + 2);
  });
});
