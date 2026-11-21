import { createHmac, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { pgAs, urls } from './env';

/**
 * Database-level guarantees of the ingest epic that an in-process fake cannot prove:
 * UNIQUE (tenant_id, source, external_event_id) under real parallelism, the atomic outbox row, and the
 * conditional UPDATE that consumes a spin credit. Needs the compose stack with the engagement service
 * configured as in docs/specs/engagement-ingest.md section 10 (static dev tenants and wheel seed).
 *
 * Mutations (re-applied by the reviewer):
 *  - drop UNIQUE (tenant_id, source, external_event_id) from inbound_events -> the parallel-dedupe test.
 *  - make the inbound insert and the outbox insert two transactions         -> INV-ING-ATOMIC-DB (a
 *    trigger makes the outbox insert fail for one event id; the inbound row must roll back with it).
 *  - replace `UPDATE ... WHERE status='available'` with read-then-write      -> INV-SPIN-ONE-WINNER-DB.
 *  - drop `FOR UPDATE SKIP LOCKED` from the consume subselect                -> INV-SPIN-ONE-WINNER-DB-3
 *    (3 credits, 50 parallel: fewer than 3 winners).
 *  - consume without a row limit (no `LIMIT 1` subselect)                    -> INV-SPIN-ONE-PER-REQUEST-DB.
 *  - drop `user_id` from the consume query                                  -> INV-SPIN-OWNERSHIP-DB-NO-CREDIT-ID
 *    (the no-credit_id path, where a dropped user_id really spends another player's credit).
 *  - consume and spin insert in separate transactions, or no runIdempotent  -> INV-SPIN-REPLAY-PARALLEL-DB.
 *  - drop a UNIQUE, grant UPDATE on an immutable table, or allow used -> available
 *                                                                           -> INV-ENGAGEMENT-SCHEMA-DB.
 */

const T1 = {
  slug: 'ingest-t1',
  id: '0190a1b2-c3d4-4e5f-8a6b-1000000000a1',
  secret: 'dev-ingest-secret-1',
};
const T2 = {
  slug: 'ingest-t2',
  id: '0190a1b2-c3d4-4e5f-8a6b-1000000000a2',
  secret: 'dev-ingest-secret-2',
};
const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');

function depositA(secret: string, eventId: string) {
  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    eventId,
    playerId: 'compose-player',
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

async function asTenant<T>(tenantId: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const db = await pgAs('engagement');
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

describe('spin: the atomic consume', () => {
  const PLAYER = '0190a1b2-c3d4-4e5f-8a6b-2000000000b1';
  const OTHER = '0190a1b2-c3d4-4e5f-8a6b-2000000000b2';
  const WHEEL = '0190a1b2-c3d4-4e5f-8a6b-2000000000c1';

  async function seed(credits: Array<{ id: string; user: string }>) {
    await asTenant(T1.id, async (db) => {
      await db.query(
        `INSERT INTO reward_tables (tenant_id, wheel_id, version, definition)
         VALUES ($1, $2, 1, $3) ON CONFLICT DO NOTHING`,
        [
          T1.id,
          WHEEL,
          JSON.stringify({
            name: 't',
            segments: [
              { label: 'Win', weight: 1, reward: { type: 'coins', amount: 5 } },
              { label: 'Nothing', weight: 1, reward: { type: 'nothing' } },
            ],
          }),
        ],
      );
      for (const c of credits) {
        await db.query(
          `INSERT INTO spin_credits (id, tenant_id, user_id, wheel_id, source_event_id, rule_id, rule_version, seq, status)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 'available')`,
          [c.id, T1.id, c.user, WHEEL, randomUUID(), randomUUID()],
        );
      }
    });
  }
  const spin = (user: string, key: string, body: object = {}) =>
    fetch(`${urls.engagement}/v1/spins`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': T1.id,
        'x-principal-id': user,
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });

  it('INV-SPIN-ONE-WINNER-DB: 50 parallel spins with different keys on one credit give one 201 and 49 409', async () => {
    const credit = randomUUID();
    const user = randomUUID();
    await seed([{ id: credit, user }]);
    const all = await Promise.all(Array.from({ length: 50 }, () => spin(user, randomUUID())));
    const codes = all.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(49);
    const spins = await asTenant(T1.id, (db) =>
      db.query(`SELECT id FROM spins WHERE credit_id = $1`, [credit]),
    );
    expect(spins.rowCount).toBe(1);
  });

  it("INV-SPIN-OWNERSHIP-DB: another player's credit id is 404 and the credit stays available", async () => {
    const credit = randomUUID();
    await seed([{ id: credit, user: OTHER }]);
    const res = await spin(PLAYER, randomUUID(), { credit_id: credit });
    expect(res.status).toBe(404);
    const row = await asTenant(T1.id, (db) =>
      db.query(`SELECT status FROM spin_credits WHERE id = $1`, [credit]),
    );
    expect(row.rows[0].status).toBe('available');
  });

  const creditStates = (user: string) =>
    asTenant(T1.id, async (db) =>
      (
        await db.query(
          `SELECT status, count(*)::int AS n FROM spin_credits WHERE user_id = $1 GROUP BY status`,
          [user],
        )
      ).rows.reduce(
        (acc: Record<string, number>, r: { status: string; n: number }) => ({
          ...acc,
          [r.status]: r.n,
        }),
        {},
      ),
    );
  const spinRows = (user: string) =>
    asTenant(
      T1.id,
      async (db) => (await db.query(`SELECT id FROM spins WHERE user_id = $1`, [user])).rows,
    );

  it('INV-SPIN-ONE-PER-REQUEST-DB: one spin without credit_id uses exactly one of the three credits of the player', async () => {
    const user = randomUUID();
    await seed([1, 2, 3].map(() => ({ id: randomUUID(), user })));
    expect((await spin(user, randomUUID())).status).toBe(201);
    expect(await creditStates(user)).toEqual({ used: 1, available: 2 });
    expect(await spinRows(user)).toHaveLength(1);
  });

  it('INV-SPIN-ONE-WINNER-DB-3: a player with 3 credits and 50 parallel spins (different keys) gets exactly three 201, 47 409, 3 spin rows, no credit left', async () => {
    const user = randomUUID();
    await seed([1, 2, 3].map(() => ({ id: randomUUID(), user })));
    const all = await Promise.all(Array.from({ length: 50 }, () => spin(user, randomUUID())));
    const codes = all.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(47);
    expect(await spinRows(user)).toHaveLength(3);
    expect((await creditStates(user)).available ?? 0).toBe(0);
  });

  it('INV-SPIN-OWNERSHIP-DB-NO-CREDIT-ID: a player with no credit who spins with {} gets 409 and never spends the credit of another player', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await seed([{ id: randomUUID(), user: owner }]);
    expect((await spin(stranger, randomUUID(), {})).status).toBe(409);
    expect(await creditStates(owner)).toEqual({ available: 1 });
    expect(await spinRows(stranger)).toHaveLength(0);
    expect(await spinRows(owner)).toHaveLength(0);
  });

  it('INV-SPIN-REPLAY-PARALLEL-DB: 20 parallel spins with one key and two credits give one spin, one used credit and one spin.completed; a later replay returns it; another body is 422', async () => {
    const user = randomUUID();
    const [c1, c2] = [randomUUID(), randomUUID()];
    await seed([
      { id: c1, user },
      { id: c2, user },
    ]);
    const key = randomUUID();
    const all = await Promise.all(Array.from({ length: 20 }, () => spin(user, key)));
    const codes = all.map((r) => r.status);
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true); // 409 = in progress, retryable
    const winners = await Promise.all(
      all
        .filter((r) => r.status === 201)
        .map(async (r) => ((await r.json()) as { spin_id: string }).spin_id),
    );
    expect(winners.length).toBeGreaterThan(0);
    const spinId = winners[0]!;
    expect(new Set(winners)).toEqual(new Set([spinId]));
    expect(await creditStates(user)).toEqual({ used: 1, available: 1 });
    expect(await spinRows(user)).toHaveLength(1);
    const outbox = await asTenant(T1.id, (db) =>
      db.query(
        `SELECT envelope FROM outbox WHERE type = 'engagement.spin.completed' AND envelope->'payload'->>'spin_id' = $1`,
        [spinId],
      ),
    );
    expect(outbox.rowCount).toBe(1);
    // D-1: the payload is everything payments needs to credit coins with key spin:<spin_id>
    expect(outbox.rows[0].envelope.payload).toMatchObject({
      spin_id: spinId,
      player_id: user,
      table_version: 1,
    });
    // a later replay returns the stored result
    const replay = await spin(user, key);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { spin_id: string }).spin_id).toBe(spinId);
    // the same key with another body is 422 and changes nothing
    const other = (await creditStatesIds(user)).available;
    const changed = await spin(user, key, { credit_id: other });
    expect(changed.status).toBe(422);
    expect(await creditStates(user)).toEqual({ used: 1, available: 1 });
    expect(await spinRows(user)).toHaveLength(1);
  });
  const creditStatesIds = (user: string) =>
    asTenant(T1.id, async (db) => {
      const rows = (
        await db.query(`SELECT id, status FROM spin_credits WHERE user_id = $1`, [user])
      ).rows;
      return {
        available: rows.find((r: { status: string }) => r.status === 'available')?.id as string,
      };
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
        SELECT t.relname AS tbl, array_agg(a.attname ORDER BY k.ord) AS cols
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

  it('INV-ENGAGEMENT-SCHEMA-DB: the engagement role cannot UPDATE or DELETE the immutable tables, and can UPDATE only status and used_at of spin_credits', async () => {
    const admin = await pgAs('postgres', 'engagement');
    try {
      for (const table of IMMUTABLE) {
        for (const priv of ['UPDATE', 'DELETE']) {
          const { rows } = await admin.query(
            `SELECT has_table_privilege('engagement', $1, $2) AS ok`,
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
          `SELECT has_column_privilege('engagement', 'public.spin_credits', $1, 'UPDATE') AS ok`,
          [col],
        );
        expect([col, rows[0].ok]).toEqual([col, col === 'status' || col === 'used_at']);
      }
    } finally {
      await admin.end();
    }
  });

  it('INV-ENGAGEMENT-SCHEMA-DB: a used spin credit can never become available again', async () => {
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
});
