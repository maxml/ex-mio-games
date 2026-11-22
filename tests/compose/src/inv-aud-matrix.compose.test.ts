import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { platformAdmin, pgAs, serviceSecrets, urls, type Service } from './env';
import { newTenant, type PlayerSession, type TestTenant } from './player-session';

/*
 * INV-AUD-MATRIX (coordinator decision D-26; test owner, written before the fix). Compose: the real
 * identity, engagement and payments, every route of each, read from the controllers' source.
 * Subsumes INV-ID-AUD-2/3 (rc review R1).
 *
 * Rule (D-26 INV-AUD): the audit `decision` is `refused` for every AUTHORIZATION refusal, from a
 * guard or from a policy check inside the service, and `allowed` with the real HTTP status for every
 * other outcome. The audit record is the FINAL `audit.acting_request` / `audit.service_call` envelope
 * that the entry point writes to the callee's outbox (D-21: written at finalize, then relayed to
 * identity's audit log; audit-intents.compose checks that reader).
 *
 * The oracle, per service rule:
 *   - every 403 is an authorization refusal. All three services answer 403 only for authorization
 *     (identity spec section 3 `authorize` outcomes, payments `forbidden`/`acting_forbidden`,
 *     engagement `forbidden`/`ACTING_FORBIDDEN`), so a 403 audited `allowed` is a defect;
 *   - the tenant-boundary 404 is an authorization refusal only where a service documents it as one:
 *     identity's `authorize` (other tenant's object -> NOT_FOUND) for NON-platform subjects. An acting
 *     subject gets ACTING_TENANT_MISMATCH (403) instead, so in the acting column every 404 is a data
 *     miss (engagement and payments: lookups scoped by RLS, documented as 404 not-found) -> `allowed`;
 *   - every other status (2xx, 400, 404, 409, 422, 5xx) is `allowed` with that status.
 *
 * Principals walked: operator_admin of A, operator_staff of A (the "viewer" role, X-15), a player of
 * A, an acting platform_admin acting for A, the operator_admin of another tenant B; plus the service
 * callers on every internal route.
 * D-11 audits ACTING requests and service calls only, so the four non-acting principals produce no
 * audit record; for them the matrix asserts exactly that (INV-AUD-MATRIX-3), and the owner question
 * Q-AUD-1 in the report asks whether their refusals should be audited too.
 *
 * Mutations (re-applied by the reviewer):
 *  - `auditDecision` returns `status >= 400 ? 'refused' : 'allowed'` -> every acting 4xx that is not a
 *    403 turns red (e.g. identity GET /v1/players/:userId 404, payments 400s);
 *  - payments RolesGuard refuses with a plain error AFTER the handler started -> its 403 rows red;
 *  - drop a route from ROUTES -> INV-AUD-MATRIX-0 red.
 */

const ROOT = resolve(__dirname, '../../..');
const PW = 'correct horse battery';

// ---- the route inventory, from the controllers' source -------------------------------------------

interface Route {
  service: Service;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  template: string;
  isPublic: boolean;
  internal: boolean;
}

const walk = (dir: string): string[] => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true }) as string[])
    .map((p) => join(dir, p))
    .filter((p) => /\.ts$/.test(p))
    .filter((p) => !/\.(test|itest|pgtest|spec)\.ts$/.test(p) && !/(^|\/)testing\//.test(p));
};

function inventory(service: Service): Route[] {
  const out: Route[] = [];
  for (const file of walk(join('apps', service, 'src'))) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    if (!src.includes('@Controller(')) continue;
    let prefix = '';
    let block: string[] = [];
    for (const raw of src.split('\n')) {
      const t = raw.trim();
      const ctl = /^@Controller\((?:'([^']*)')?\)/.exec(t);
      if (ctl) {
        prefix = ctl[1] ?? '';
        block = [];
        continue;
      }
      if (t.startsWith('@')) {
        block.push(t);
        continue;
      }
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '') continue;
      const deco = block
        .map((b) => /^@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/.exec(b))
        .find(Boolean);
      if (deco) {
        const path = `/${[prefix, deco[2] ?? ''].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
        out.push({
          service,
          method: deco[1]!.toUpperCase() as Route['method'],
          template: path,
          isPublic: block.some((b) => b.startsWith('@Public(')),
          internal: path.startsWith('/internal/'),
        });
      }
      block = [];
    }
  }
  return out;
}

const SERVICES_UNDER_TEST = ['identity', 'engagement', 'payments'] as const;
const ROUTES: Route[] = SERVICES_UNDER_TEST.flatMap(inventory);
const keyOf = (r: Route) => `${r.service} ${r.method} ${r.template}`;

// ---- the world ------------------------------------------------------------------------------------

type Http = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (
  base: string,
  method: string,
  path: string,
  opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Http> =>
  new Promise((ok, fail) => {
    const u = new URL(`${base}${path}`);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json: unknown = data;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            /* text body */
          }
          ok({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', fail);
    req.end(payload);
  });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const subOf = (jwt: string): string =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')).sub as string;

type PrincipalName = 'operator_admin' | 'operator_staff' | 'player' | 'acting' | 'other_tenant';
interface World {
  A: TestTenant;
  B: TestTenant;
  playerA: PlayerSession;
  playerB: PlayerSession;
  /** Access token per principal and target service. */
  tokens: Record<PrincipalName, Record<Service, string>>;
  subs: Record<PrincipalName, string>;
  /** Service tokens: caller -> callee -> token (undefined when identity does not issue it). */
  svc: Record<'engagement' | 'payments', Partial<Record<Service, string>>>;
}
let w: World;

const loginOn = async (host: string, email: string, password: string, audience: Service) => {
  const r = await call(urls.identity, 'POST', '/v1/auth/login', {
    host,
    body: { email, password, audience },
  });
  if (r.status !== 200) throw new Error(`login ${email} (${audience}) -> ${r.status}`);
  return r.json.access_token as string;
};

beforeAll(async () => {
  const A = await newTenant();
  const B = await newTenant();
  const playerA = await A.player();
  const playerB = await B.player();
  const perService = async (f: (s: Service) => Promise<string>) =>
    Object.fromEntries(
      await Promise.all(SERVICES_UNDER_TEST.map(async (s) => [s, await f(s)] as const)),
    ) as Record<Service, string>;

  const opA = await perService((s) => A.operatorToken(s));
  const opB = await perService((s) => B.operatorToken(s));
  const staffEmail = `viewer-${randomUUID().slice(0, 8)}@${A.slug}.test`;
  const invited = await call(urls.identity, 'POST', '/v1/staff', {
    headers: bearer(opA.identity),
    body: { email: staffEmail, password: PW, role: 'operator_staff' },
  });
  if (invited.status !== 201) throw new Error(`staff invite -> ${invited.status}`);
  const staff = await perService((s) => loginOn(`${A.slug}.mio.localhost`, staffEmail, PW, s));
  const root = await loginOn(
    platformAdmin.host,
    platformAdmin.email,
    platformAdmin.password,
    'identity',
  );
  const acting = await perService(async (audience) => {
    const r = await call(urls.identity, 'POST', '/v1/auth/acting', {
      headers: bearer(root),
      body: { tenant_id: A.tenantId, reason: 'INV-AUD-MATRIX review walk', audience },
    });
    if (r.status !== 200) throw new Error(`acting (${audience}) -> ${r.status}`);
    return r.json.access_token as string;
  });
  const playerToken = playerA.headers.authorization!.slice('Bearer '.length);
  const tokens: World['tokens'] = {
    operator_admin: opA,
    operator_staff: staff,
    player: { identity: playerToken, engagement: playerToken, payments: playerToken },
    acting,
    other_tenant: opB,
  };
  const subs = Object.fromEntries(
    Object.entries(tokens).map(([p, t]) => [p, subOf(t.identity)]),
  ) as World['subs'];

  const svc: World['svc'] = { engagement: {}, payments: {} };
  for (const caller of ['engagement', 'payments'] as const) {
    for (const audience of SERVICES_UNDER_TEST) {
      const r = await call(urls.identity, 'POST', '/v1/auth/service-token', {
        body: { client_id: caller, client_secret: serviceSecrets[caller], audience },
      });
      if (r.status === 200) svc[caller][audience] = r.json.access_token as string;
    }
  }
  w = { A, B, playerA, playerB, tokens, subs, svc };
}, 180_000);

// ---- per-route request fixtures (every non-public route must have one) ---------------------------

interface Req {
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}
type Variant = 'own' | 'other';
/** The request for a route; `other` names an object of tenant B (the other-tenant leg). */
type Fixture = (w: World, v: Variant) => Req;

const rnd = () => randomUUID();
const idem = () => ({ 'idempotency-key': `inv-aud-${randomUUID()}` });
const tenantOf = (w: World, v: Variant) => (v === 'own' ? w.A.tenantId : w.B.tenantId);
const playerOf = (w: World, v: Variant) => (v === 'own' ? w.playerA.userId : w.playerB.userId);
const ITEM = {
  name: 'INV-AUD probe item',
  price: 5,
  reward: { type: 'free_spins', params: { count: 1 } },
};

/** Routes whose other-tenant leg is meaningful (they take an object id of a tenant or player). */
const OTHER_LEG = new Set([
  'identity GET /v1/tenants/:id',
  'identity GET /v1/players/:userId',
  'payments GET /v1/players/:player_id/balance',
]);

const FIXTURES: Record<string, Fixture> = {
  // identity
  'identity POST /v1/auth/realtime-ticket': () => ({ path: '/v1/auth/realtime-ticket', body: {} }),
  'identity POST /v1/auth/acting': (w) => ({
    path: '/v1/auth/acting',
    body: { tenant_id: w.A.tenantId, reason: 'INV-AUD-MATRIX nested acting' },
  }),
  'identity POST /v1/staff': (w) => ({
    path: '/v1/staff',
    body: {
      email: `m-${randomUUID().slice(0, 8)}@${w.A.slug}.test`,
      password: PW,
      role: 'operator_staff',
    },
  }),
  'identity GET /v1/staff': () => ({ path: '/v1/staff' }),
  'identity GET /v1/players/:userId': (w, v) => ({ path: `/v1/players/${playerOf(w, v)}` }),
  'identity GET /v1/tenants/:id': (w, v) => ({ path: `/v1/tenants/${tenantOf(w, v)}` }),
  // Always tenant B: no principal here may suspend, and A must stay active for the walk.
  'identity POST /v1/tenants/:id/suspend': (w) => ({ path: `/v1/tenants/${w.B.tenantId}/suspend` }),
  'identity GET /v1/credentials': () => ({ path: '/v1/credentials' }),
  'identity POST /v1/credentials': () => ({
    path: '/v1/credentials',
    body: { platform: 'inv-aud-probe', environment: 'sandbox' },
  }),
  'identity POST /v1/credentials/:keyId/rotate': () => ({
    path: '/v1/credentials/mio_unknown_key/rotate',
    body: { grace_seconds: 60 },
  }),
  'identity GET /v1/audit': () => ({ path: '/v1/audit' }),
  // engagement
  'engagement GET /v1/tenant-projection': () => ({ path: '/v1/tenant-projection' }),
  'engagement GET /v1/store/items': () => ({ path: '/v1/store/items' }),
  'engagement GET /v1/operator/store/items': () => ({ path: '/v1/operator/store/items' }),
  'engagement POST /v1/store/items': () => ({ path: '/v1/store/items', body: ITEM }),
  'engagement PATCH /v1/store/items/:id': () => ({
    path: `/v1/store/items/${rnd()}`,
    body: { name: 'INV-AUD renamed' },
  }),
  'engagement POST /v1/spins': () => ({ path: '/v1/spins', body: {}, headers: idem() }),
  'engagement GET /v1/wheel': () => ({ path: '/v1/wheel' }),
  'engagement GET /v1/wheel/:wheelId': () => ({ path: `/v1/wheel/${rnd()}` }),
  'engagement GET /v1/me/spins': () => ({ path: '/v1/me/spins' }),
  'engagement POST /v1/redemptions': () => ({
    path: '/v1/redemptions',
    body: { item_id: rnd() },
    headers: idem(),
  }),
  'engagement GET /v1/redemptions/:id': () => ({ path: `/v1/redemptions/${rnd()}` }),
  'engagement GET /v1/me/redemptions': () => ({ path: '/v1/me/redemptions' }),
  'engagement GET /v1/operator/redemptions': () => ({ path: '/v1/operator/redemptions' }),
  'engagement GET /v1/operator/redemptions/:id': () => ({
    path: `/v1/operator/redemptions/${rnd()}`,
  }),
  'engagement POST /v1/operator/redemptions/:id/resolve': () => ({
    path: `/v1/operator/redemptions/${rnd()}/resolve`,
    body: { outcome: 'not_issued', reason: 'INV-AUD probe' },
  }),
  // payments
  'payments GET /v1/billing/plans': () => ({ path: '/v1/billing/plans' }),
  'payments POST /v1/billing/attempts': () => ({ path: '/v1/billing/attempts', body: {} }),
  'payments GET /v1/billing/attempts/:id': () => ({ path: `/v1/billing/attempts/${rnd()}` }),
  'payments POST /v1/billing/attempts/:id/cancel': () => ({
    path: `/v1/billing/attempts/${rnd()}/cancel`,
  }),
  'payments GET /v1/billing/subscription': () => ({ path: '/v1/billing/subscription' }),
  'payments GET /v1/billing/invoices': () => ({ path: '/v1/billing/invoices' }),
  'payments GET /v1/billing/usage': () => ({ path: '/v1/billing/usage' }),
  'payments GET /v1/platform/ledger/reconciliation': () => ({
    path: '/v1/platform/ledger/reconciliation',
  }),
  'payments GET /v1/me/balance': () => ({ path: '/v1/me/balance' }),
  'payments GET /v1/players/:player_id/balance': (w, v) => ({
    path: `/v1/players/${playerOf(w, v)}/balance`,
  }),
  // internal (service callers); the tenant is A
  'identity POST /internal/v1/realtime-tickets/redeem': () => ({
    path: '/internal/v1/realtime-tickets/redeem',
    body: { ticket: 'inv-aud-not-a-ticket' },
  }),
  'identity GET /internal/v1/tenants/:tenantId/status': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/status`,
  }),
  'identity POST /internal/v1/tenants/:tenantId/players/resolve': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/players/resolve`,
    body: { platform: 'sim-casino', external_player_id: w.playerA.externalPlayerId },
  }),
  'identity GET /internal/v1/tenants/:tenantId/integration': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/integration`,
  }),
  'identity GET /internal/v1/integrations/by-slug/:slug': (w) => ({
    path: `/internal/v1/integrations/by-slug/${w.A.slug}`,
  }),
  'identity GET /internal/v1/tenants/:tenantId/players/:userId/link': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/players/${w.playerB.userId}/link`,
  }),
  'payments POST /internal/v1/tenants/:tenantId/reserves': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/reserves`,
    body: {
      player_id: w.playerA.userId,
      reserve_id: rnd(),
      amount: 1,
      currency: 'COIN',
      sandbox: false,
    },
    headers: idem(),
  }),
  'payments POST /internal/v1/tenants/:tenantId/reserves/:reserveId/capture': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/reserves/${rnd()}/capture`,
    body: {},
    headers: idem(),
  }),
  'payments POST /internal/v1/tenants/:tenantId/reserves/:reserveId/release': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/reserves/${rnd()}/release`,
    body: {},
    headers: idem(),
  }),
  'payments POST /internal/v1/tenants/:tenantId/reserves/:reserveId/refund': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/reserves/${rnd()}/refund`,
    body: {},
    headers: idem(),
  }),
  'payments GET /internal/v1/tenants/:tenantId/players/:playerId/balance': (w) => ({
    path: `/internal/v1/tenants/${w.A.tenantId}/players/${w.playerA.userId}/balance`,
  }),
};

// ---- reading the audit record ---------------------------------------------------------------------

interface Audit {
  decision: string;
  status: number;
}

/** The database clock, so "written after this request started" is one clock. */
async function dbNow(service: Service): Promise<string> {
  const db = await pgAs('postgres', service);
  try {
    return (await db.query(`SELECT clock_timestamp()::text AS t`)).rows[0].t as string;
  } finally {
    await db.end();
  }
}

/** Final audit envelopes of `type` for `route`, written since `since`, filtered by `match`. */
async function auditRows(
  service: Service,
  type: 'audit.acting_request' | 'audit.service_call',
  since: string,
  where: { route?: string; actor?: string; caller?: string },
): Promise<Audit[]> {
  const db = await pgAs('postgres', service);
  try {
    const rows = await db.query(
      `SELECT envelope->'payload' AS p FROM outbox
        WHERE type = $1 AND created_at >= $2::timestamptz
          AND ($3::text IS NULL OR envelope->'payload'->>'route' = $3)
          AND ($4::text IS NULL OR envelope->'payload'->>'actor_user_id' = $4)
          AND ($5::text IS NULL OR envelope->'payload'->>'caller_service' = $5)
        ORDER BY created_at`,
      [type, since, where.route ?? null, where.actor ?? null, where.caller ?? null],
    );
    return rows.rows.map((r) => ({ decision: r.p.decision, status: Number(r.p.status) }));
  } finally {
    await db.end();
  }
}

async function finalAudit(
  service: Service,
  type: 'audit.acting_request' | 'audit.service_call',
  since: string,
  where: { route: string; actor?: string; caller?: string },
): Promise<Audit[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await auditRows(service, type, since, where);
    if (rows.length > 0 || Date.now() > deadline) {
      await new Promise((r) => setTimeout(r, 300)); // a duplicate would show now
      return auditRows(service, type, since, where);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** D-26 oracle (see the header): 403 is a refusal; everything else is allowed with its status. */
const expected = (status: number): Audit => ({
  decision: status === 403 ? 'refused' : 'allowed',
  status,
});

// ---- the tests ------------------------------------------------------------------------------------

const userRoutes = ROUTES.filter((r) => !r.isPublic && !r.internal);
const internalRoutes = ROUTES.filter((r) => !r.isPublic && r.internal);

describe('INV-AUD-MATRIX-0 the route inventory (D-26)', () => {
  // Mutation: delete a fixture, or add a route without one.
  it('every non-public route of identity, engagement and payments has a request fixture', () => {
    for (const s of SERVICES_UNDER_TEST) {
      expect([s, ROUTES.filter((r) => r.service === s).length > 5]).toEqual([s, true]);
    }
    const missing = ROUTES.filter((r) => !r.isPublic && !(keyOf(r) in FIXTURES)).map(keyOf);
    expect(missing).toEqual([]);
    const stale = Object.keys(FIXTURES).filter((k) => !ROUTES.some((r) => keyOf(r) === k));
    expect(stale).toEqual([]);
  });
});

const legsOf = (r: Route): Variant[] => (OTHER_LEG.has(keyOf(r)) ? ['own', 'other'] : ['own']);

describe('INV-AUD-MATRIX-1 acting platform_admin: refusals `refused`, every other outcome `allowed` with its status', () => {
  for (const r of userRoutes) {
    for (const leg of legsOf(r)) {
      it(`INV-AUD-MATRIX-1 acting ${r.service} ${r.method} ${r.template} [${leg}]`, async () => {
        const fixture = FIXTURES[keyOf(r)];
        if (!fixture) throw new Error(`no fixture for ${keyOf(r)}`);
        const req = fixture(w, leg);
        const since = await dbNow(r.service);
        const res = await call(urls[r.service], r.method, req.path, {
          headers: { ...bearer(w.tokens.acting[r.service]), ...req.headers },
          body: req.body,
        });
        const rows = await finalAudit(r.service, 'audit.acting_request', since, {
          route: `${r.method} ${r.template}`,
          actor: w.subs.acting,
        });
        // the observed cell, for the report's matrix table
        process.stdout.write(
          `MATRIX acting ${r.service} ${r.method} ${r.template} [${leg}] -> ${res.status} ${
            res.json?.code ?? ''
          } audit=${JSON.stringify(rows)}\n`,
        );
        // one final record, describing this response the D-26 way
        expect({ status: res.status, code: res.json?.code, audit: rows }).toEqual({
          status: res.status,
          code: res.json?.code,
          audit: [expected(res.status)],
        });
      });
    }
  }
});

describe('INV-AUD-MATRIX-2 service callers: refusals `refused`, every other outcome `allowed` with its status', () => {
  for (const r of internalRoutes) {
    for (const caller of ['engagement', 'payments'] as const) {
      it(`INV-AUD-MATRIX-2 svc:${caller} -> ${r.service} ${r.method} ${r.template}`, async () => {
        const token = w.svc[caller][r.service];
        if (!token) {
          // identity does not issue this caller a token for this audience (D-14 issue allow-list):
          // nothing reaches the route, so there is nothing to audit. Pinned, not skipped.
          expect(caller === 'payments' && r.service === 'payments').toBe(true);
          return;
        }
        const fixture = FIXTURES[keyOf(r)];
        if (!fixture) throw new Error(`no fixture for ${keyOf(r)}`);
        const req = fixture(w, 'own');
        const since = await dbNow(r.service);
        const res = await call(urls[r.service], r.method, req.path, {
          headers: { ...bearer(token), ...req.headers },
          body: req.body,
        });
        const rows = await finalAudit(r.service, 'audit.service_call', since, {
          route: `${r.method} ${r.template}`,
          caller,
        });
        process.stdout.write(
          `MATRIX svc:${caller} ${r.service} ${r.method} ${r.template} -> ${res.status} ${
            res.json?.code ?? ''
          } audit=${JSON.stringify(rows)}\n`,
        );
        expect({ status: res.status, code: res.json?.code, audit: rows }).toEqual({
          status: res.status,
          code: res.json?.code,
          audit: [expected(res.status)],
        });
      });
    }
  }

  // RED at 8351d55: the entry point's own 400 (tenant check) is written `refused`. A malformed tenant
  // is validation, not authorization (D-26: every other outcome is `allowed` with its status).
  it.each(['identity', 'payments'] as const)(
    'INV-AUD-MATRIX-2b svc:engagement -> %s with a malformed path tenant: 400, audited allowed/400',
    async (service) => {
      const r = internalRoutes.find(
        (x) => x.service === service && x.method === 'GET' && x.template.includes(':tenantId'),
      );
      if (!r) throw new Error(`no tenant-scoped GET internal route on ${service}`);
      const path = r.template
        .replace(':tenantId', 'not-a-uuid')
        .replace(/:(\w+)/g, () => randomUUID());
      const since = await dbNow(service);
      const res = await call(urls[service], 'GET', path, {
        headers: bearer(w.svc.engagement[service]!),
      });
      expect(res.status).toBe(400);
      const rows = await finalAudit(service, 'audit.service_call', since, {
        route: `GET ${r.template}`,
        caller: 'engagement',
      });
      expect(rows).toEqual([{ decision: 'allowed', status: 400 }]);
    },
  );
});

describe('INV-AUD-MATRIX-3 non-acting principals: walked on every route, no acting audit (D-11 scope)', () => {
  const others: PrincipalName[] = ['operator_admin', 'operator_staff', 'player', 'other_tenant'];
  for (const p of others) {
    for (const s of SERVICES_UNDER_TEST) {
      it(`INV-AUD-MATRIX-3 ${p} on every ${s} route writes no audit.acting_request`, async () => {
        const since = await dbNow(s);
        const seen: string[] = [];
        for (const r of userRoutes.filter((x) => x.service === s)) {
          for (const leg of legsOf(r)) {
            const req = FIXTURES[keyOf(r)]!(w, leg);
            const res = await call(urls[s], r.method, req.path, {
              headers: { ...bearer(w.tokens[p][s]), ...req.headers },
              body: req.body,
            });
            seen.push(`${res.status} ${r.method} ${r.template} [${leg}]`);
          }
        }
        // the walk reached handlers and guards, not a blanket 401
        expect(seen.filter((x) => !x.startsWith('401')).length).toBeGreaterThan(0);
        process.stdout.write(`MATRIX ${p} ${s}: ${seen.join(' | ')}\n`);
        await new Promise((r) => setTimeout(r, 500));
        expect(await auditRows(s, 'audit.acting_request', since, { actor: w.subs[p] })).toEqual([]);
      });
    }
  }
});
