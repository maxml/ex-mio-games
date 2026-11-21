import { request } from 'node:http';
import type { Client } from 'pg';
import { JwksResponse, uuidv7 } from '@ex-mio/contracts';
import { pgAs, urls } from './env';

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
        `SELECT count(*)::int AS n FROM tenants WHERE type = 'platform'`,
      );
      expect(seeded.rows[0].n).toBe(1);
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

  // Mutation: grant BYPASSRLS to the identity role, or forget SET LOCAL.
  it('INV-DB-6 as the service role with no tenant set, every tenant table reads zero rows and refuses writes', async () => {
    const c = await pgAs('identity');
    try {
      for (const table of TENANT_TABLES) {
        const rows = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect({ table, n: rows.rows[0].n }).toEqual({ table, n: 0 });
      }
      await expect(
        c.query(
          `INSERT INTO users (tenant_id, id, email, kind) VALUES ($1, $2, 'x@x.test', 'staff')`,
          [uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow(/row-level security|foreign key|violates/);
    } finally {
      await c.end();
    }
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
    expect((await get(`${urls.engagement}/v1/tenant-projection`, headers)).status).not.toBe(401);
    expect((await get(`${urls.payments}/v1/credits`, headers)).status).toBe(401);
  });
});
