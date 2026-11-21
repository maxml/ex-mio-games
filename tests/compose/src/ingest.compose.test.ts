import { createHmac, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { MySpinsResponse, SpinConflictBody, SpinResponse } from '@ex-mio/contracts';
import { pgAs, urls } from './env';
import { newTenant, type PlayerSession, type TestTenant } from './player-session';

/**
 * Database-level guarantees of the ingest epic that an in-process fake cannot prove:
 * UNIQUE (tenant_id, source, external_event_id) under real parallelism, the atomic outbox row, and the
 * conditional UPDATE that consumes a spin credit. Needs the compose stack with the engagement service
 * configured as in docs/specs/engagement-ingest.md section 10 (static dev tenants, wheel seed, and the
 * runtime role `engagement_app`).
 *
 * Authentication: the webhook is signed (no token). Every spin and me/spins call carries a player
 * token from the identity service (player-session.ts, a real launch); no `x-tenant-id` or
 * `x-principal-id` header is sent anywhere (D-4, D-12). All database work runs as `engagement_app`, the
 * runtime role, except the catalog checks and the fault trigger, which use the admin.
 *
 * Mutations (re-applied by the reviewer):
 *  - drop UNIQUE (tenant_id, source, external_event_id) from inbound_events -> the parallel-dedupe test.
 *  - make the inbound insert and the outbox insert two transactions         -> INV-ING-ATOMIC-DB (a
 *    trigger makes the outbox insert fail for one event id; the inbound row must roll back with it).
 *  - replace `UPDATE ... WHERE status='available'` with read-then-write      -> INV-SPIN-ONE-WINNER-DB.
 *  - consume without a row limit (no `LIMIT 1` subselect)                    -> INV-SPIN-ONE-PER-REQUEST-DB.
 *  - drop `user_id` from the consume query                                  -> INV-SPIN-OWNERSHIP-DB-NO-CREDIT-ID
 *    (the no-credit_id path, where a dropped user_id really spends another player's credit).
 *  - consume and spin insert in separate transactions, or no runIdempotent  -> INV-SPIN-REPLAY-PARALLEL-DB.
 *  - drop a UNIQUE, grant UPDATE on an immutable table, or allow used -> available
 *                                                                           -> INV-ENGAGEMENT-SCHEMA-DB.
 *  - keep a raw `external_player_id` column in inbound_events, or store the raw value in the hash
 *    column                                                                  -> INV-ING-NO-RAW-ID-DB.
 *  - make `engagement_app` the owner of a table, give it CREATEROLE/superuser, or let it disable the
 *    trigger or RLS                                                          -> INV-ENGAGEMENT-ROLE-DB.
 *  - count spin credits of every player in /v1/me/spins                      -> INV-ME-SPINS-DB.
 *  - a 409 without the body code, or `no_credit` for a same-key duplicate    -> INV-SPIN-CONFLICT-CODE-DB.
 *
 * Not a mutation (R2-4): dropping `FOR UPDATE SKIP LOCKED` from the consume subselect. It was
 * claimed to turn "3 credits, 50 parallel" red; measured 30/30 runs give 3 winners with or without
 * it, because READ COMMITTED re-checks the row after the lock wait. `SKIP LOCKED` is a throughput
 * choice and no test here pretends to pin it.
 */

const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');

/*
 * int/all review: T1 and T2 used to be the static `INGEST_STATIC_TENANTS` stand-ins (spec section 10),
 * which the compose stack does not configure: engagement reads integrations from identity (X-7), so
 * every webhook to `ingest-t1` was 404. They are now real tenants: operator signup plus a production
 * credential for the `casino-a` adapter, whose `hmac_secret` is the webhook secret identity serves.
 * The player hash key is identity's derivation (`credentials.service.ts`: HMAC(KEK, `player-hash-key:<tenant>`))
 * with the compose KEK. The properties of every test below are unchanged.
 */
const COMPOSE_KEK = 'dev-credentials-kek-0000000000'; // docker-compose.yml CREDENTIALS_KEK (dev only)
type IngestTenant = { slug: string; id: string; secret: string; hashKey: string };
const T1 = {} as IngestTenant;
const T2 = {} as IngestTenant;
beforeAll(async () => {
  for (const t of [T1, T2]) {
    const made = await newTenant({ platform: 'casino-a' });
    Object.assign(t, {
      slug: made.slug,
      id: made.tenantId,
      secret: made.credential.hmac_secret,
      hashKey: hmac(COMPOSE_KEK, `player-hash-key:${made.tenantId}`),
    });
  }
});

function depositA(secret: string, eventId: string, playerId = 'compose-player') {
  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    eventId,
    playerId,
    amount: { value: 5000, currency: 'EUR' },
    status: 'SUCCESS',
    ts,
  });
  return {
    raw,
    headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac(secret, `${ts}.${raw}`) },
  };
}
const postDeposit = (slug: string, b: { raw: string; headers: Record<string, string> }) =>
  fetch(`${urls.engagement}/v1/integrations/${slug}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...b.headers },
    body: b.raw,
  });

/** Runs `fn` in one transaction as the RUNTIME role, with the tenant set (RLS applies). */
async function asTenant<T>(tenantId: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await pgAs('engagement_app');
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } finally {
    await db.end();
  }
}

describe('ingest: database guarantees', () => {
  it('INV-ING-DEDUPE-DB: 20 parallel identical webhooks give one inbound row, one outbox message, all 200', async () => {
    const eventId = `par-${randomUUID()}`;
    const built = depositA(T1.secret, eventId);
    const all = await Promise.all(Array.from({ length: 20 }, () => postDeposit(T1.slug, built)));
    expect(all.map((r) => r.status)).toEqual(Array(20).fill(200));
    const bodies = await Promise.all(all.map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);
    const { inbound, outbox } = await asTenant(T1.id, async (db) => ({
      inbound: (
        await db.query(
          `SELECT id FROM inbound_events WHERE source = 'casino-a' AND external_event_id = $1`,
          [eventId],
        )
      ).rows,
      outbox: (
        await db.query(
          `SELECT event_id FROM outbox WHERE type = 'engagement.deposit.confirmed' AND envelope->'payload'->>'external_event_id' = $1`,
          [eventId],
        )
      ).rows,
    }));
    expect(inbound).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('INV-ING-DEDUPE-TENANT-DB: the same external_event_id in two tenants is two rows', async () => {
    const eventId = `two-${randomUUID()}`;
    expect((await postDeposit(T1.slug, depositA(T1.secret, eventId))).status).toBe(200);
    expect((await postDeposit(T2.slug, depositA(T2.secret, eventId))).status).toBe(200);
    for (const t of [T1, T2]) {
      const rows = await asTenant(t.id, (db) =>
        db.query(`SELECT 1 FROM inbound_events WHERE external_event_id = $1`, [eventId]),
      );
      expect(rows.rowCount).toBe(1); // RLS: each tenant sees only its own
    }
  });

  it("INV-ING-CROSS-TENANT-DB: tenant 2's secret on tenant 1's endpoint is 401 and writes nothing", async () => {
    const eventId = `x-${randomUUID()}`;
    expect((await postDeposit(T1.slug, depositA(T2.secret, eventId))).status).toBe(401);
    const rows = await asTenant(T1.id, (db) =>
      db.query(`SELECT 1 FROM inbound_events WHERE external_event_id = $1`, [eventId]),
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe('ingest: the raw casino player id is not stored (D-12, MIO-107)', () => {
  // Mutation: keep `external_player_id` as a column of inbound_events, or put the raw value in
  // `external_player_hmac`. The raw id lives only in the identity player mapping.
  it('INV-ING-NO-RAW-ID-DB: inbound_events has an HMAC column and no raw-id column; the stored value is the tenant-keyed HMAC and the raw value is in NO table, the outbox included (X-1)', async () => {
    const eventId = `hmac-${randomUUID()}`;
    const raw = `raw-casino-player-${randomUUID()}`;
    expect((await postDeposit(T1.slug, depositA(T1.secret, eventId, raw))).status).toBe(200);
    const admin = await pgAs('postgres', 'engagement');
    try {
      const cols = (
        await admin.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'inbound_events'`,
        )
      ).rows.map((r) => r.column_name);
      expect(cols).toContain('external_player_hmac');
      expect(cols.filter((c) => /external_player(_id)?$/.test(c))).toEqual([]);
      const row = (
        await admin.query(
          `SELECT external_player_hmac FROM inbound_events WHERE external_event_id = $1`,
          [eventId],
        )
      ).rows[0];
      expect(row.external_player_hmac).toBe(hmac(T1.hashKey, `casino-a\n${raw}`));
      expect(row.external_player_hmac).not.toContain(raw);
      // Erasure (MIO-107) deletes the identity mapping row. What remains in engagement must hold no
      // raw id: scan every row of EVERY public table, the outbox included. X-1/D-12: the
      // deposit.confirmed event carries only the internal player_id (resolved through identity before
      // the outbox write), so the outbox row is not a durable copy of the raw id that erasure cannot
      // reach. Mutation: put external_player_id back into DepositConfirmedV1, or resolve at the consumer.
      const tables = (
        await admin.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )
      ).rows.map((r) => r.table_name);
      expect(tables).toContain('inbound_events');
      expect(tables).toContain('outbox');
      const evt = (
        await admin.query(
          `SELECT envelope FROM outbox WHERE type = 'engagement.deposit.confirmed'
              AND envelope->'payload'->>'external_event_id' = $1`,
          [eventId],
        )
      ).rows[0];
      expect(evt.envelope.payload).toHaveProperty('player_id');
      expect(evt.envelope.payload).not.toHaveProperty('external_player_id');
      for (const t of tables) {
        const hit = await admin.query(`SELECT 1 FROM "${t}" x WHERE x::text LIKE $1 LIMIT 1`, [
          `%${raw}%`,
        ]);
        expect([t, hit.rowCount]).toEqual([t, 0]);
      }
    } finally {
      await admin.end();
    }
  });
});

describe('spin: the atomic consume', () => {
  const WHEEL = '0190a1b2-c3d4-4e5f-8a6b-2000000000c1';

  /** A tenant with one wheel table, and its players (real launches through identity). */
  async function setup(): Promise<{ tenant: TestTenant; player: () => Promise<PlayerSession> }> {
    const tenant = await newTenant();
    await asTenant(tenant.tenantId, (db) =>
      db.query(
        `INSERT INTO reward_tables (tenant_id, wheel_id, version, definition)
         VALUES ($1, $2, 1, $3)`,
        [
          tenant.tenantId,
          WHEEL,
          JSON.stringify({
            name: 't',
            segments: [
              { label: 'Win', weight: 1, reward: { type: 'coins', amount: 5 } },
              { label: 'Nothing', weight: 1, reward: { type: 'nothing' } },
            ],
          }),
        ],
      ),
    );
    return { tenant, player: () => tenant.player() };
  }
  const seed = (tenantId: string, credits: Array<{ id: string; user: string }>) =>
    asTenant(tenantId, async (db) => {
      for (const c of credits) {
        await db.query(
          `INSERT INTO spin_credits (id, tenant_id, user_id, wheel_id, source_event_id, rule_id, rule_version, seq, status)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 'available')`,
          [c.id, tenantId, c.user, WHEEL, randomUUID(), randomUUID()],
        );
      }
    });
  const spin = (p: PlayerSession, key: string, body: object = {}) =>
    fetch(`${urls.engagement}/v1/spins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...p.headers, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  const conflictCodes = async (rs: Response[]) =>
    Promise.all(rs.map(async (r) => SpinConflictBody.parse(await r.json()).code));

  const creditStates = (p: PlayerSession) =>
    asTenant(p.tenantId, async (db) =>
      (
        await db.query(
          `SELECT status, count(*)::int AS n FROM spin_credits WHERE user_id = $1 GROUP BY status`,
          [p.userId],
        )
      ).rows.reduce(
        (acc: Record<string, number>, r: { status: string; n: number }) => ({
          ...acc,
          [r.status]: r.n,
        }),
        {},
      ),
    );
  const spinRows = (p: PlayerSession) =>
    asTenant(
      p.tenantId,
      async (db) => (await db.query(`SELECT id FROM spins WHERE user_id = $1`, [p.userId])).rows,
    );

  it('INV-SPIN-ONE-WINNER-DB: 50 parallel spins with different keys on one credit give one 201 and 49 409 `no_credit`', async () => {
    const { player } = await setup();
    const p = await player();
    const credit = randomUUID();
    await seed(p.tenantId, [{ id: credit, user: p.userId }]);
    const all = await Promise.all(Array.from({ length: 50 }, () => spin(p, randomUUID())));
    const won = all.filter((r) => r.status === 201);
    const lost = all.filter((r) => r.status === 409);
    expect([won.length, lost.length]).toEqual([1, 49]);
    expect(SpinResponse.safeParse(await won[0]!.json()).success).toBe(true); // incl. segment_index
    expect(new Set(await conflictCodes(lost))).toEqual(new Set(['no_credit']));
    expect(await spinRows(p)).toHaveLength(1);
  });

  it("INV-SPIN-OWNERSHIP-DB: another player's credit id is 404 and the credit stays available", async () => {
    const { player } = await setup();
    const [a, b] = [await player(), await player()];
    const credit = randomUUID();
    await seed(a.tenantId, [{ id: credit, user: b.userId }]);
    const res = await spin(a, randomUUID(), { credit_id: credit });
    expect(res.status).toBe(404);
    expect(await creditStates(b)).toEqual({ available: 1 });
  });

  it('INV-SPIN-ONE-PER-REQUEST-DB: one spin without credit_id uses exactly one of the three credits of the player', async () => {
    const { player } = await setup();
    const p = await player();
    await seed(
      p.tenantId,
      [1, 2, 3].map(() => ({ id: randomUUID(), user: p.userId })),
    );
    expect((await spin(p, randomUUID())).status).toBe(201);
    expect(await creditStates(p)).toEqual({ used: 1, available: 2 });
    expect(await spinRows(p)).toHaveLength(1);
  });

  it('INV-SPIN-ONE-WINNER-DB-3: a player with 3 credits and 50 parallel spins (different keys) gets exactly three 201, 47 409, 3 spin rows, no credit left', async () => {
    const { player } = await setup();
    const p = await player();
    await seed(
      p.tenantId,
      [1, 2, 3].map(() => ({ id: randomUUID(), user: p.userId })),
    );
    const all = await Promise.all(Array.from({ length: 50 }, () => spin(p, randomUUID())));
    expect(all.filter((r) => r.status === 201)).toHaveLength(3);
    const lost = all.filter((r) => r.status === 409);
    expect(lost).toHaveLength(47);
    expect(new Set(await conflictCodes(lost))).toEqual(new Set(['no_credit']));
    expect(await spinRows(p)).toHaveLength(3);
    expect((await creditStates(p)).available ?? 0).toBe(0);
  });

  it('INV-SPIN-OWNERSHIP-DB-NO-CREDIT-ID: a player with no credit who spins with {} gets 409 `no_credit` and never spends the credit of another player', async () => {
    const { player } = await setup();
    const [owner, stranger] = [await player(), await player()];
    await seed(owner.tenantId, [{ id: randomUUID(), user: owner.userId }]);
    const res = await spin(stranger, randomUUID(), {});
    expect(res.status).toBe(409);
    expect(SpinConflictBody.parse(await res.json()).code).toBe('no_credit');
    expect(await creditStates(owner)).toEqual({ available: 1 });
    expect(await spinRows(stranger)).toHaveLength(0);
    expect(await spinRows(owner)).toHaveLength(0);
  });

  it('INV-SPIN-REPLAY-PARALLEL-DB: 20 parallel spins with one key and two credits give one spin, one used credit and one spin.completed; duplicates in flight are 409 `in_progress`; a later replay returns it; another body is 422', async () => {
    const { player } = await setup();
    const p = await player();
    const [c1, c2] = [randomUUID(), randomUUID()];
    await seed(p.tenantId, [
      { id: c1, user: p.userId },
      { id: c2, user: p.userId },
    ]);
    const key = randomUUID();
    const all = await Promise.all(Array.from({ length: 20 }, () => spin(p, key)));
    expect(all.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    // R2-5: the in-flight duplicate is `in_progress` (retry with the key), never `no_credit`: a
    // second credit is still available, so "no spins left" would be false.
    expect(new Set(await conflictCodes(all.filter((r) => r.status === 409)))).toEqual(
      all.some((r) => r.status === 409) ? new Set(['in_progress']) : new Set(),
    );
    const winnerBodies = await Promise.all(
      all
        .filter((r) => r.status === 201)
        .map(async (r) => (await r.json()) as { spin_id: string; segment_index: number }),
    );
    const winners = winnerBodies.map((b) => b.spin_id);
    expect(winners.length).toBeGreaterThan(0);
    const spinId = winners[0]!;
    expect(new Set(winners)).toEqual(new Set([spinId]));
    expect(await creditStates(p)).toEqual({ used: 1, available: 1 });
    expect(await spinRows(p)).toHaveLength(1);
    const outbox = await asTenant(p.tenantId, (db) =>
      db.query(
        `SELECT envelope FROM outbox WHERE type = 'engagement.spin.completed' AND envelope->'payload'->>'spin_id' = $1`,
        [spinId],
      ),
    );
    expect(outbox.rowCount).toBe(1);
    // D-1: the payload is everything payments needs to credit coins with key spin:<spin_id>
    expect(outbox.rows[0].envelope.payload).toMatchObject({
      spin_id: spinId,
      player_id: p.userId,
      table_version: 1,
    });
    // a later replay returns the stored result, with the same segment_index
    const first = winnerBodies[0]!;
    const replay = await spin(p, key);
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as { spin_id: string; segment_index: number };
    expect(replayBody.spin_id).toBe(spinId);
    expect(replayBody.segment_index).toBe(first.segment_index);
    // the same key with another body is 422 and changes nothing
    const left = await asTenant(
      p.tenantId,
      async (db) =>
        (
          await db.query(
            `SELECT id FROM spin_credits WHERE user_id = $1 AND status = 'available'`,
            [p.userId],
          )
        ).rows[0].id as string,
    );
    const changed = await spin(p, key, { credit_id: left });
    expect(changed.status).toBe(422);
    expect(await creditStates(p)).toEqual({ used: 1, available: 1 });
    expect(await spinRows(p)).toHaveLength(1);
  });

  // Mutation: count credits of every player of the tenant, ignore status, or serve it without a token.
  it('INV-ME-SPINS-DB: GET /v1/me/spins is the available count of the token player only; tenant-scoped; no token is 401', async () => {
    const { player } = await setup();
    const [a, b] = [await player(), await player()];
    await seed(a.tenantId, [
      { id: randomUUID(), user: a.userId },
      { id: randomUUID(), user: a.userId },
      { id: randomUUID(), user: b.userId },
    ]);
    const mine = (p: PlayerSession) =>
      fetch(`${urls.engagement}/v1/me/spins`, { headers: p.headers });
    expect(MySpinsResponse.parse(await (await mine(a)).json())).toEqual({ available: 2 });
    expect(MySpinsResponse.parse(await (await mine(b)).json())).toEqual({ available: 1 });
    expect((await spin(a, randomUUID())).status).toBe(201);
    expect(MySpinsResponse.parse(await (await mine(a)).json())).toEqual({ available: 1 });
    // another tenant's player with the same external id has their own count (tenant-scoped)
    const other = await (await setup()).player();
    expect(MySpinsResponse.parse(await (await mine(other)).json())).toEqual({ available: 0 });
    expect((await fetch(`${urls.engagement}/v1/me/spins`)).status).toBe(401);
  });

  // int/all review, D-13 / X-2: "a sandbox flag cannot remove a paid operation from the bill".
  // A player launched through a sandbox credential is the SAME identity user as through the
  // production one (identity resolves the player by tenant, platform and casino id). Today
  // `consume` ignores the credit's environment, and the spin is flagged sandbox when the TOKEN is
  // sandbox, so a production credit (from a production deposit) is spent by a sandbox spin: the
  // coins go to the sandbox wallet and the spin is not metered. Credits are per environment, like
  // wallets: a sandbox token neither sees nor spends a production credit (and vice versa).
  // Mutation: drop the environment condition from the consume query (or from countAvailable).
  it('INV-SPIN-ENV-DB: a sandbox token neither counts nor spends a production credit of the same player; no sandbox spin.completed consumes it', async () => {
    const { tenant, player } = await setup();
    const prod = await player();
    const sbx = await tenant.sandboxPlayer(prod.externalPlayerId);
    expect(sbx.userId).toBe(prod.userId); // precondition: one identity user, two environments
    const creditId = randomUUID();
    await seed(prod.tenantId, [{ id: creditId, user: prod.userId }]); // a production credit
    const mine = (p: PlayerSession) =>
      fetch(`${urls.engagement}/v1/me/spins`, { headers: p.headers });
    expect(MySpinsResponse.parse(await (await mine(prod)).json())).toEqual({ available: 1 });
    expect(MySpinsResponse.parse(await (await mine(sbx)).json())).toEqual({ available: 0 });

    const res = await spin(sbx, randomUUID());
    expect(res.status).toBe(409);
    expect((await conflictCodes([res]))[0]).toBe('no_credit');
    expect(await creditStates(prod)).toEqual({ available: 1 });
    const sandboxSpins = await asTenant(
      prod.tenantId,
      async (db) =>
        (
          await db.query(
            `SELECT count(*)::int AS n FROM outbox WHERE type = 'engagement.spin.completed'
              AND envelope->'payload'->>'player_id' = $1 AND (envelope->>'sandbox')::boolean IS TRUE`,
            [prod.userId],
          )
        ).rows[0].n as number,
    );
    expect(sandboxSpins).toBe(0);
    // the production token still spends it, as a production spin
    expect((await spin(prod, randomUUID())).status).toBe(201);
  });
});

describe('ingest: atomic inbound row and outbox row', () => {
  it('INV-ING-ATOMIC-DB: when the outbox insert fails the inbound row rolls back with it, and the retry is accepted once', async () => {
    const eventId = `atomic-${randomUUID()}`;
    const admin = await pgAs('postgres', 'engagement');
    try {
      // fault hook: the outbox insert for exactly this external_event_id raises
      await admin.query(`
        CREATE OR REPLACE FUNCTION test_fail_outbox_${eventId.replace(/-/g, '_')}() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$ LANGUAGE plpgsql`);
      await admin.query(`
        CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW
        WHEN (NEW.type = 'engagement.deposit.confirmed' AND NEW.envelope->'payload'->>'external_event_id' = '${eventId}')
        EXECUTE FUNCTION test_fail_outbox_${eventId.replace(/-/g, '_')}()`);
      const failed = await postDeposit(T1.slug, depositA(T1.secret, eventId));
      expect(failed.status).toBeGreaterThanOrEqual(500);
      const afterFailure = await asTenant(T1.id, (db) =>
        db.query(`SELECT 1 FROM inbound_events WHERE external_event_id = $1`, [eventId]),
      );
      expect(afterFailure.rowCount).toBe(0); // no inbound row without its outbox row
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS test_fail_outbox ON outbox`);
      await admin.query(`DROP FUNCTION IF EXISTS test_fail_outbox_${eventId.replace(/-/g, '_')}()`);
      await admin.end();
    }
    // the casino retries: the event is not lost and not duplicated
    expect((await postDeposit(T1.slug, depositA(T1.secret, eventId))).status).toBe(200);
    const { inbound, outbox } = await asTenant(T1.id, async (db) => ({
      inbound: (
        await db.query(`SELECT 1 FROM inbound_events WHERE external_event_id = $1`, [eventId])
      ).rowCount,
      outbox: (
        await db.query(
          `SELECT 1 FROM outbox WHERE type = 'engagement.deposit.confirmed' AND envelope->'payload'->>'external_event_id' = $1`,
          [eventId],
        )
      ).rowCount,
    }));
    expect([inbound, outbox]).toEqual([1, 1]);
  });
});

describe('engagement schema (catalog, as the admin)', () => {
  const UNIQUES: Array<[string, string[]]> = [
    ['inbound_events', ['tenant_id', 'source', 'external_event_id']],
    ['spin_credits', ['tenant_id', 'source_event_id', 'rule_id', 'seq']],
    ['spins', ['tenant_id', 'user_id', 'operation_id']],
    ['reward_tables', ['tenant_id', 'wheel_id', 'version']],
    ['rules', ['tenant_id', 'rule_id', 'version']],
  ];
  const IMMUTABLE = ['reward_tables', 'rules', 'spins', 'inbound_events'];

  it('INV-ENGAGEMENT-SCHEMA-DB: the UNIQUE constraints exist on exactly these columns', async () => {
    const admin = await pgAs('postgres', 'engagement');
    try {
      const { rows } = await admin.query<{ tbl: string; cols: string[] }>(`
        SELECT t.relname AS tbl, array_agg(a.attname::text ORDER BY k.ord) AS cols
          FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
          CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE i.indisunique AND i.indpred IS NULL
         GROUP BY t.relname, i.indexrelid`);
      for (const [table, cols] of UNIQUES) {
        const found = rows.some(
          (r) => r.tbl === table && JSON.stringify(r.cols) === JSON.stringify(cols),
        );
        expect([table, found]).toEqual([table, true]);
      }
    } finally {
      await admin.end();
    }
  });

  it('INV-ENGAGEMENT-SCHEMA-DB: the runtime role engagement_app cannot UPDATE or DELETE the immutable tables, and can UPDATE only status and used_at of spin_credits', async () => {
    const admin = await pgAs('postgres', 'engagement');
    try {
      for (const table of IMMUTABLE) {
        for (const priv of ['UPDATE', 'DELETE']) {
          const { rows } = await admin.query(
            `SELECT has_table_privilege('engagement_app', $1, $2) AS ok`,
            [`public.${table}`, priv],
          );
          expect([table, priv, rows[0].ok]).toEqual([table, priv, false]);
        }
      }
      const cols = (
        await admin.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'spin_credits'`,
        )
      ).rows.map((r) => r.column_name);
      expect(cols).toEqual(
        expect.arrayContaining(['status', 'used_at', 'user_id', 'tenant_id', 'id']),
      );
      for (const col of cols) {
        const { rows } = await admin.query(
          `SELECT has_column_privilege('engagement_app', 'public.spin_credits', $1, 'UPDATE') AS ok`,
          [col],
        );
        expect([col, rows[0].ok]).toEqual([col, col === 'status' || col === 'used_at']);
      }
    } finally {
      await admin.end();
    }
  });

  it('INV-ENGAGEMENT-SCHEMA-DB: a used spin credit can never become available again (as the runtime role)', async () => {
    const user = randomUUID();
    const credit = randomUUID();
    const WHEEL_ID = '0190a1b2-c3d4-4e5f-8a6b-2000000000c9';
    await asTenant(T1.id, async (db) => {
      await db.query(
        `INSERT INTO spin_credits (id, tenant_id, user_id, wheel_id, source_event_id, rule_id, rule_version, seq, status)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 'available')`,
        [credit, T1.id, user, WHEEL_ID, randomUUID(), randomUUID()],
      );
      await db.query(`UPDATE spin_credits SET status = 'used', used_at = now() WHERE id = $1`, [
        credit,
      ]);
    });
    await expect(
      asTenant(T1.id, (db) =>
        db.query(`UPDATE spin_credits SET status = 'available' WHERE id = $1 AND status = 'used'`, [
          credit,
        ]),
      ),
    ).rejects.toThrow();
    const row = await asTenant(T1.id, (db) =>
      db.query(`SELECT status FROM spin_credits WHERE id = $1`, [credit]),
    );
    expect(row.rows[0].status).toBe('used');
  });

  // D-12 (R2-6): the guards above are only as strong as the role that runs the app. The migration
  // owner is `engagement`; the runtime role `engagement_app` owns nothing, so it cannot undo them.
  // Mutation: make engagement_app the owner of a table, give it a role attribute (superuser,
  // BYPASSRLS, CREATEROLE), or GRANT it ownership-like rights (TRIGGER, REFERENCES are not enough
  // to drop a trigger, but ownership is).
  it('INV-ENGAGEMENT-ROLE-DB: engagement_app is not an owner and cannot drop a trigger, disable a trigger, disable or un-force RLS, drop a table or grant itself UPDATE', async () => {
    const app = await pgAs('engagement_app');
    const admin = await pgAs('postgres', 'engagement');
    const snapshot = async () => ({
      triggers: (
        await admin.query(
          `SELECT c.relname AS tbl, t.tgname AS name, t.tgenabled AS enabled
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE NOT t.tgisinternal
            ORDER BY c.relname, t.tgname`,
        )
      ).rows as Array<{ tbl: string; name: string; enabled: string }>,
      rls: (
        await admin.query(
          `SELECT c.relname AS tbl, c.relrowsecurity AS on, c.relforcerowsecurity AS forced
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE c.relkind = 'r'
              -- int/all review: the bus tables carry tenant_id for diagnosis and are read across
              -- tenants by design (same exception as roles.compose.test.ts BUS_TABLES)
              AND c.relname NOT IN ('outbox', 'inbox')
              AND EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
            ORDER BY c.relname`,
        )
      ).rows as Array<{ tbl: string; on: boolean; forced: boolean }>,
    });
    try {
      const role = await app.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
      const owned = await app.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
      );
      expect(owned.rows).toEqual([]);

      const before = await snapshot();
      expect(before.triggers.some((t) => t.tbl === 'spin_credits')).toBe(true); // used -> available guard
      expect(before.rls.length).toBeGreaterThan(0);
      // every offender by name (D-24: work queues too), not a bare false
      expect(before.rls.filter((r) => !(r.on && r.forced)).map((r) => r.tbl)).toEqual([]);

      const attempts: string[] = [];
      for (const t of before.triggers) {
        attempts.push(`DROP TRIGGER "${t.name}" ON "${t.tbl}"`);
        attempts.push(`ALTER TABLE "${t.tbl}" DISABLE TRIGGER "${t.name}"`);
      }
      for (const r of before.rls) {
        attempts.push(`ALTER TABLE "${r.tbl}" DISABLE ROW LEVEL SECURITY`);
        attempts.push(`ALTER TABLE "${r.tbl}" NO FORCE ROW LEVEL SECURITY`);
      }
      attempts.push('ALTER TABLE spin_credits DISABLE TRIGGER ALL', 'DROP TABLE spin_credits');
      for (const sql of attempts) {
        const outcome = await app.query(sql).then(
          () => 'succeeded',
          (e: Error) => e.message,
        );
        expect([sql, outcome]).toEqual([
          sql,
          expect.stringMatching(/must be owner|permission denied/i),
        ]);
      }
      // GRANT by a non-owner without grant option only warns: check the effect, not the statement
      await app.query('GRANT UPDATE ON spins TO engagement_app').catch(() => undefined);
      const grant = await admin.query(
        `SELECT has_table_privilege('engagement_app', 'public.spins', 'UPDATE') AS ok`,
      );
      expect(grant.rows[0].ok).toBe(false);

      expect(await snapshot()).toEqual(before); // nothing changed: same triggers (enabled), same RLS
    } finally {
      await app.end();
      await admin.end();
    }
  });
});
