import { request } from 'node:http';
import { DataSource } from 'typeorm';
import { createEvent, type EventEnvelope, PLATFORM_TENANT_ID } from '@ex-mio/contracts';
import {
  AUDIT_INTENT_SWEEP_AFTER_SECONDS,
  AuditIntentGoneError,
  createOutboxAuditPort,
  Db,
} from '@ex-mio/service-kit';
import { eventually, pgAs, platformAdmin, urls } from './env';

/*
 * Reviewer tests (identity epic review, D-21 M1) on real Postgres: the two-step audit port the
 * entry point uses, over identity's own database and as its RUNTIME role (`identity_app`), so the
 * grants are part of what is tested. The unit twin is packages/service-kit/src/audit-intents.test.ts.
 *
 * The running identity relay polls the same outbox, so these tests never take rows from it: "the
 * relay would publish it" is checked with the relay's own selection (bus/outbox.ts pollOnce).
 *
 * Mutations: see each test.
 */

const RELAY_SELECT = `SELECT "event_id" FROM "outbox"
  WHERE "published_at" IS NULL AND "parked_at" IS NULL AND "next_attempt_at" <= now()
    AND "event_id" = $1`;

let ds: DataSource;
let db: Db;
let port: ReturnType<typeof createOutboxAuditPort>;

beforeAll(async () => {
  ds = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 54329),
    username: 'identity_app',
    password: 'identity-app-dev',
    database: 'identity',
    poolSize: 6,
  });
  await ds.initialize();
  db = new Db(ds);
  port = createOutboxAuditPort(() => db);
});
afterAll(async () => {
  await ds?.destroy();
});

const event = (): EventEnvelope =>
  createEvent({
    type: 'audit.acting_request',
    tenantId: PLATFORM_TENANT_ID,
    sandbox: false,
    payload: {
      actor_user_id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c',
      actor_tenant_id: PLATFORM_TENANT_ID,
      acting_tenant_id: PLATFORM_TENANT_ID,
      reason: 'compose review',
      service: 'identity',
      method: 'GET',
      route: 'GET /v1/staff',
      decision: 'allowed',
      status: 200,
      request_id: 'req-compose',
      occurred_at: new Date().toISOString(),
    },
  });

// D-32 F1: a connection with no tenant sees no intent unless it opts in to the platform scan, so the
// helper opts in the way the audit port does (a transaction with `app.platform_scan`).
const intents = async (id: string) =>
  Number(
    await ds.transaction(async (tx) => {
      await tx.query(`SET LOCAL app.platform_scan = 'on'`);
      return (
        await tx.query(`SELECT count(*)::int AS n FROM "audit_intents" WHERE "event_id" = $1`, [id])
      )[0].n;
    }),
  );
const outboxRows = async (id: string): Promise<EventEnvelope[]> =>
  (await ds.query(`SELECT "envelope" FROM "outbox" WHERE "event_id" = $1`, [id])).map(
    (r: { envelope: EventEnvelope }) => r.envelope,
  );
/** The runtime role cannot UPDATE intents (by design); age them as the migration owner. */
const age = async (id: string, seconds: number) => {
  const owner = await pgAs('identity_owner');
  try {
    // FORCE RLS applies to the owner too (D-32 F1): opt in to the platform scan like the port does.
    // Fix round 2 (test owner): under RLS an UPDATE that the policy hides matches 0 rows and does not
    // fail. A silent no-op here would leave the intent young: M1-PG-4's "young stays" would pass
    // vacuously and M1-PG-5 would never race (finalize alone wins, and `refused` is an allowed
    // outcome). So the helper proves it aged exactly the one intent.
    // Mutation: drop the platform-scan opt-in above -> this throws in M1-PG-4 and M1-PG-5.
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.platform_scan = 'on'`);
    const aged = await owner.query(
      `UPDATE "audit_intents" SET "created_at" = now() - make_interval(secs => $2) WHERE "event_id" = $1`,
      [id, seconds],
    );
    if (aged.rowCount !== 1) {
      await owner.query('ROLLBACK');
      throw new Error(`age(${id}): expected to age 1 intent, aged ${aged.rowCount}`);
    }
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
};
const finalOf = (e: EventEnvelope, decision: string, status: number): EventEnvelope => {
  const copy = JSON.parse(JSON.stringify(e)) as EventEnvelope;
  Object.assign(copy.payload as object, { decision, status });
  return copy;
};

describe('M1 two-step audit on Postgres (reviewer, D-21)', () => {
  // Mutation: the port writes to the outbox at write time.
  it('M1-PG-1/2 an intent is invisible to the relay: no outbox row exists until finalize', async () => {
    const e = event();
    await port(e);
    expect(await intents(e.event_id)).toBe(1);
    expect(await outboxRows(e.event_id)).toEqual([]);
    expect(await ds.query(RELAY_SELECT, [e.event_id])).toEqual([]);
    await port.finalize(finalOf(e, 'allowed', 200));
    // now the row exists (the running relay may already have marked it published)
    expect(await outboxRows(e.event_id)).toHaveLength(1);
  });

  // Mutation: finalize publishes the stored provisional envelope, or keeps the intent.
  it('M1-PG-3 finalize writes the real decision and status and deletes the intent in one transaction', async () => {
    const e = event();
    await port(e);
    await port.finalize(finalOf(e, 'refused', 404));
    expect(await intents(e.event_id)).toBe(0);
    const rows = await outboxRows(e.event_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ decision: 'refused', status: 404 });
  });

  // Mutation: sweep without the age filter, or a shorter window.
  it('M1-PG-4 the sweep publishes an intent as aborted only once it is older than 60 s', async () => {
    const young = event();
    const old = event();
    await port(young);
    await port(old);
    await age(young.event_id, AUDIT_INTENT_SWEEP_AFTER_SECONDS - 5);
    await age(old.event_id, AUDIT_INTENT_SWEEP_AFTER_SECONDS + 5);
    await port.sweep();
    expect(await intents(young.event_id)).toBe(1);
    expect(await outboxRows(young.event_id)).toEqual([]);
    expect(await intents(old.event_id)).toBe(0);
    const rows = await outboxRows(old.event_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ decision: 'aborted', status: 500 });
    await port.finalize(finalOf(young, 'allowed', 200)); // leave nothing behind
  });

  // Mutation: finalize publishes without checking that its DELETE took the row.
  it('M1-PG-5 finalize and sweep racing on real connections publish each event exactly once', async () => {
    for (let i = 0; i < 12; i++) {
      const e = event();
      await port(e);
      await age(e.event_id, AUDIT_INTENT_SWEEP_AFTER_SECONDS + 1);
      const fin = finalOf(e, 'refused', 403);
      const results = await Promise.allSettled(
        i % 2 ? [port.finalize(fin), port.sweep()] : [port.sweep(), port.finalize(fin)],
      );
      const rows = await outboxRows(e.event_id);
      expect(rows).toHaveLength(1);
      expect(await intents(e.event_id)).toBe(0);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AuditIntentGoneError);
      }
      const decision = (rows[0]?.payload as { decision: string }).decision;
      expect(['refused', 'aborted']).toContain(decision);
    }
  });
});

// ---- the reader: identity's own acting requests reach the operator's audit log -------------------

type Http = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (
  method: 'GET' | 'POST',
  path: string,
  opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Http> =>
  new Promise((resolve, reject) => {
    const u = new URL(`${urls.identity}${path}`);
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
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('M1 reader: the final audit record is consumed and described correctly (D-11, D-21)', () => {
  /*
   * rc review, D-24: the audit decision is the AUTHORIZATION outcome. The old "refused" leg was a
   * 404 from the handler; under D-24 that is an `allowed` call carrying status 404, so it moved to
   * the first test. The refused leg is now a real authorization refusal (an acting session may not
   * start acting, ACTING_FORBIDDEN). RED at fc5bf59: identity decides it inside the handler and the
   * entry point records every handler answer as `allowed` (rc review INV-ID-AUD-2, the unit pin).
   */
  const actingOnIdentity = async () => {
    const slug = `aud${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const signup = await call('POST', '/v1/operators/signup', {
      host: 'localhost',
      body: {
        tenant_name: slug,
        slug,
        email: `boss@${slug}.test`,
        password: 'correct horse battery',
      },
    });
    expect(signup.status).toBe(201);
    const tenantId = signup.json.tenant.id as string;
    const op = await call('POST', '/v1/auth/login', {
      host: `${slug}.mio.localhost`,
      body: { email: `boss@${slug}.test`, password: 'correct horse battery', audience: 'identity' },
    });
    expect(op.status).toBe(200);
    const root = await call('POST', '/v1/auth/login', {
      host: platformAdmin.host,
      body: { email: platformAdmin.email, password: platformAdmin.password, audience: 'identity' },
    });
    expect(root.status).toBe(200);
    const acting = await call('POST', '/v1/auth/acting', {
      headers: bearer(root.json.access_token),
      body: { tenant_id: tenantId, reason: 'compose review ticket', audience: 'identity' },
    });
    expect(acting.status).toBe(200);
    const auditRows = (n: number) =>
      eventually(async () => {
        const r = await call('GET', '/v1/audit', { headers: bearer(op.json.access_token) });
        const list = (r.json as Array<Record<string, unknown>>).filter(
          (e) => e.action === 'acting.request',
        );
        return list.length >= n ? list : undefined;
      }, 30_000);
    return { tenantId, actingToken: acting.json.access_token as string, auditRows };
  };

  // Mutation: identity_app without inbox rights, the consumer drops audit events, the record keeps
  // the provisional decision, or the decision is taken from the HTTP status (404 -> refused).
  it('an allowed acting request and a handler 404 on identity show in GET /v1/audit as `allowed` (D-24)', async () => {
    const w = await actingOnIdentity();
    const allowed = await call('GET', '/v1/staff', { headers: bearer(w.actingToken) });
    expect(allowed.status).toBe(200);
    const notFound = await call('GET', '/v1/players/0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2f', {
      headers: bearer(w.actingToken),
    });
    expect(notFound.status).toBe(404);
    const rows = await w.auditRows(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: 'identity',
          route: 'GET /v1/staff',
          decision: 'allowed',
        }),
        expect.objectContaining({
          service: 'identity',
          route: 'GET /v1/players/:userId',
          decision: 'allowed',
        }),
      ]),
    );
  });

  // Mutation: none needed today. After the fix: drop the identity refusal marker -> red.
  it('a refused acting request on identity (ACTING_FORBIDDEN) shows in GET /v1/audit as `refused` (D-24)', async () => {
    const w = await actingOnIdentity();
    const refused = await call('POST', '/v1/auth/acting', {
      headers: bearer(w.actingToken),
      body: { tenant_id: w.tenantId, reason: 'compose review ticket', audience: 'identity' },
    });
    expect(refused.status).toBe(403);
    const rows = await w.auditRows(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: 'identity',
          route: 'POST /v1/auth/acting',
          decision: 'refused',
        }),
      ]),
    );
  });
});
