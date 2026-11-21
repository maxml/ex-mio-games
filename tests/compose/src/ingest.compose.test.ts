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
 *  - make the inbound insert and the outbox insert two transactions         -> INV-ING-ATOMIC-DB.
 *  - replace `UPDATE ... WHERE status='available'` with read-then-write      -> the concurrent-spins test.
 *  - drop `user_id` from the consume query                                  -> the other-player test.
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
});
