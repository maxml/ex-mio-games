import { createHmac, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { CredentialIssued } from '@ex-mio/contracts';
import { eventually, pgAs, urls } from './env';
import { newTenant } from './player-session';

/*
 * rc review (test owner) on the stack: what the int/all fixes moved.
 *
 * F5 (identity serves `sandbox.webhook_secrets` beside production; engagement takes `sandbox` from
 * the key that verified):
 *  - F5-E2E-1 (green): one tenant, production + sandbox casino-a credentials; a production-signed
 *    webhook is a production deposit and a sandbox-signed one a sandbox deposit, end to end
 *    (identity -> engagement -> outbox envelope). Mutation: engagement's sandbox set gets
 *    `sandbox: false` (unit F5-2a pins the same at the choke point).
 *  - F5-DEDUPE-ENV (RED): before F5 only one environment was live at a time; now both are, and the
 *    inbound dedupe key is still (tenant, source, external_event_id). A sandbox webhook whose event
 *    id the production casino later reuses swallows the PRODUCTION deposit (no spins credited).
 *    D-18 already put the sandbox flag into the order idempotency key for the same reason.
 *
 * D-24 work-queue RLS (`app.platform_scan` read flag for the sweeper):
 *  - WQ-SCAN-1 (RED): the flag is a plain custom GUC, so any transaction of the app role can set it,
 *    including a tenant-scoped one; the policy `USING (tenant OR scan)` then shows every tenant's
 *    queue rows to a tenant transaction. Close it at the policy: the scan branch only when no tenant
 *    is set.
 *  - WQ-SCAN-2 (green): no tenant and no flag reads nothing (FORCE RLS); the flag alone lets the
 *    sweeper read across tenants; the flag never lets it write (WITH CHECK is tenant-only).
 *    Mutation: `DISABLE ROW LEVEL SECURITY` on the queue -> red.
 */

const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');

function depositA(secret: string, eventId: string, playerId = 'rc-review-player') {
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

/** The deposit.confirmed outbox rows for one external event id, with their envelope flag. */
const deposits = (tenantId: string, eventId: string) =>
  asTenant(tenantId, async (db) =>
    (
      await db.query<{ sandbox: boolean }>(
        `SELECT COALESCE((envelope->>'sandbox')::boolean, false) AS sandbox FROM outbox
          WHERE type = 'engagement.deposit.confirmed'
            AND envelope->'payload'->>'external_event_id' = $1`,
        [eventId],
      )
    ).rows.map((r) => r.sandbox),
  );

type Tenant = { slug: string; id: string; prod: string; sbx: string };
const T = {} as Tenant;

beforeAll(async () => {
  const made = await newTenant({ platform: 'casino-a' });
  const token = await made.operatorToken('identity');
  const res = await fetch(`${urls.identity}/v1/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: 'casino-a', environment: 'sandbox' }),
  });
  if (res.status !== 201) throw new Error(`sandbox credential issue failed: ${res.status}`);
  const sbx = CredentialIssued.parse(await res.json());
  Object.assign(T, {
    slug: made.slug,
    id: made.tenantId,
    prod: made.credential.hmac_secret,
    sbx: sbx.hmac_secret,
  });
});

describe('rc review: F5 on the stack', () => {
  it('F5-E2E-1 with a sandbox credential issued, production webhooks stay production and sandbox-signed ones are sandbox', async () => {
    const prodId = `rc-prod-${randomUUID()}`;
    const sbxId = `rc-sbx-${randomUUID()}`;
    expect((await postDeposit(T.slug, depositA(T.prod, prodId))).status).toBe(200);
    expect((await postDeposit(T.slug, depositA(T.sbx, sbxId))).status).toBe(200);
    expect(await deposits(T.id, prodId)).toEqual([false]);
    expect(await deposits(T.id, sbxId)).toEqual([true]);
  });

  it('F5-DEDUPE-ENV a sandbox webhook never swallows the production deposit that reuses its event id', async () => {
    const id = `rc-both-${randomUUID()}`;
    expect((await postDeposit(T.slug, depositA(T.sbx, id))).status).toBe(200);
    expect((await postDeposit(T.slug, depositA(T.prod, id))).status).toBe(200);
    const flags = await eventually(async () => {
      const f = await deposits(T.id, id);
      return f.length >= 1 ? f : undefined;
    });
    expect([...flags].sort()).toEqual([false, true]);
  });
});

describe('rc review: the sweeper read flag on redemption_work_queue (D-24)', () => {
  const A = randomUUID();
  const B = randomUUID();
  const rowA = randomUUID();

  beforeAll(async () => {
    await asTenant(A, (db) =>
      db.query(
        `INSERT INTO redemption_work_queue (redemption_id, tenant_id, next_attempt_at) VALUES ($1, $2, now())`,
        [rowA, A],
      ),
    );
  });
  afterAll(async () => {
    await asTenant(A, (db) =>
      db.query(`DELETE FROM redemption_work_queue WHERE tenant_id = $1`, [A]),
    );
  });

  const countA = (db: Client) =>
    db
      .query<{
        n: number;
      }>(`SELECT count(*)::int AS n FROM redemption_work_queue WHERE redemption_id = $1`, [rowA])
      .then((r) => r.rows[0]!.n);

  it("WQ-SCAN-1 a tenant-scoped transaction that sets app.platform_scan still sees no other tenant's queue rows", async () => {
    const seen = await asTenant(B, async (db) => {
      await db.query(`SELECT set_config('app.platform_scan', 'on', true)`);
      return countA(db);
    });
    expect(seen).toBe(0);
  });

  it('WQ-SCAN-2 no tenant and no flag reads nothing; the flag alone reads across tenants and never writes', async () => {
    const db = await pgAs('engagement_app');
    try {
      expect(await countA(db)).toBe(0);
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.platform_scan', 'on', true)`);
      expect(await countA(db)).toBe(1);
      await expect(
        db.query(`INSERT INTO redemption_work_queue (redemption_id, tenant_id) VALUES ($1, $2)`, [
          randomUUID(),
          B,
        ]),
      ).rejects.toThrow(/row-level security/);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.platform_scan', 'on', true)`);
      await expect(
        db.query(`UPDATE redemption_work_queue SET tenant_id = $2 WHERE redemption_id = $1`, [
          rowA,
          B,
        ]),
      ).rejects.toThrow(/row-level security/);
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });
});
