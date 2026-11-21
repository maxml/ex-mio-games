/**
 * Reviewer property tests (foundation r1). They run the REAL choke-point code
 * (tenancy, bus, idempotency) against the compose Postgres and RabbitMQ, in a
 * scratch database owned by the `payments` role, so a mutation in a package's
 * src shows up here without rebuilding an image.
 *
 * Tests named `FINDING` assert the property the review asks for; they are red
 * at 2d8e1f3 on purpose.
 */
import { Client } from 'pg';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { createEvent, uuidv7 } from '@ex-mio/contracts';
import { createDataSource } from '@ex-mio/service-kit';
import {
  enableTenantRls,
  runWithTenant,
  TenancyModule,
  withTenantTransaction,
} from '@ex-mio/tenancy';
import {
  createBusTables,
  enqueueEvent,
  EVENTS_EXCHANGE,
  InboxConsumer,
  OutboxRelay,
} from '@ex-mio/bus';
import {
  createIdempotencyTable,
  IdempotencyInFlightError,
  IdempotencyMismatchError,
  runIdempotent,
} from '@ex-mio/idempotency';

const PG_PORT = Number(process.env.POSTGRES_PORT ?? 54329);
const AMQP = `amqp://mio:mio-dev@localhost:${process.env.RABBITMQ_PORT ?? 55672}`;
const DB = `prop_${Date.now()}`;
const appUrl = `postgresql://payments:payments-dev@localhost:${PG_PORT}/${DB}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = uuidv7();
const B = uuidv7();

let ds: DataSource; // replica 1, as the owning app role
let ds2: DataSource; // replica 2, same role
let oracle: Client; // superuser view of the scratch DB, bypasses RLS: counts only

const open = () =>
  createDataSource({
    env: { DATABASE_URL: appUrl, NODE_ENV: 'test' },
    entities: [],
    migrations: [],
  }).initialize();

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await oracle.query(sql, params);
  return Number(rows[0].n);
}

beforeAll(async () => {
  const admin = new Client({
    host: 'localhost',
    port: PG_PORT,
    user: 'postgres',
    password: 'postgres-dev',
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${DB}" OWNER payments`);
  await admin.query(`REVOKE ALL ON DATABASE "${DB}" FROM PUBLIC`);
  await admin.end();
  ds = await open();
  ds2 = await open();
  const q = ds.createQueryRunner();
  await createBusTables(q);
  await createIdempotencyTable(q);
  await q.query(`CREATE TABLE "effects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "tag" text NOT NULL)`);
  await enableTenantRls(q, 'effects');
  await q.release();
  oracle = new Client({
    host: 'localhost',
    port: PG_PORT,
    user: 'postgres',
    password: 'postgres-dev',
    database: DB,
  });
  await oracle.connect();
});

afterAll(async () => {
  await ds?.destroy();
  await ds2?.destroy();
  await oracle?.end();
  const admin = new Client({
    host: 'localhost',
    port: PG_PORT,
    user: 'postgres',
    password: 'postgres-dev',
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.end();
});

const insertEffect = (tenant: string, tag: string) =>
  withTenantTransaction(
    ds,
    (m) =>
      m.query(`INSERT INTO "effects" ("tenant_id", "tag") VALUES ($1, $2) RETURNING "id"`, [
        tenant,
        tag,
      ]),
    tenant,
  );

// ---------------------------------------------------------------- tenancy
describe('tenancy choke points (withTenantTransaction + enableTenantRls)', () => {
  it('T1 FORCE: the owning app role sees only the transaction tenant, and no rows without one', async () => {
    await insertEffect(A, 't1');
    await insertEffect(B, 't1');
    const seen: { tenant_id: string }[] = await withTenantTransaction(
      ds,
      (m) => m.query(`SELECT "tenant_id" FROM "effects" WHERE "tag" = 't1'`),
      A,
    );
    expect(seen.map((r) => r.tenant_id)).toEqual([A]);
    const bare = await ds.query(`SELECT count(*)::int AS n FROM "effects"`);
    expect(bare[0].n).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM effects WHERE tag = 't1'`)).toBe(2);
  });

  it('T2 WITH CHECK: under tenant A the app cannot insert or move a row into tenant B', async () => {
    await expect(insertEffectAs(A, B, 't2')).rejects.toThrow(/row-level security/);
    await insertEffect(A, 't2-move');
    await expect(
      withTenantTransaction(
        ds,
        (m) => m.query(`UPDATE "effects" SET "tenant_id" = $1 WHERE "tag" = 't2-move'`, [B]),
        A,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('T3 FINDING: the app role cannot switch row-level security off on its own tables', async () => {
    let switchedOff = false;
    try {
      await ds.query(`ALTER TABLE "effects" NO FORCE ROW LEVEL SECURITY`);
      switchedOff = true;
    } catch {
      /* the wanted outcome: not the owner */
    } finally {
      if (switchedOff) await ds.query(`ALTER TABLE "effects" FORCE ROW LEVEL SECURITY`);
    }
    expect(switchedOff).toBe(false);
  });

  it('T4 FINDING: a unique key does not reveal that another tenant has a row (composite keys)', async () => {
    const [{ id }] = await insertEffect(B, 't4');
    const err = await withTenantTransaction(
      ds,
      (m) =>
        m.query(`INSERT INTO "effects" ("id", "tenant_id", "tag") VALUES ($1, $2, 't4')`, [id, A]),
      A,
    ).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/duplicate key/);
  });

  it('T5 FINDING: an explicit tenant cannot silently override a different ambient tenant', async () => {
    await expect(
      runWithTenant({ tenantId: A }, () => withTenantTransaction(ds, async () => 1, B)),
    ).rejects.toThrow();
  });

  it('T6 FINDING: the header placeholder resolver is refused in production', () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => TenancyModule.forRoot()).toThrow();
    } finally {
      process.env.NODE_ENV = old;
    }
  });
});

function insertEffectAs(txTenant: string, rowTenant: string, tag: string) {
  return withTenantTransaction(
    ds,
    (m) => m.query(`INSERT INTO "effects" ("tenant_id", "tag") VALUES ($1, $2)`, [rowTenant, tag]),
    txTenant,
  );
}

// ---------------------------------------------------------------- inbox
function fakeChannel() {
  const acks: unknown[] = [];
  const rejects: boolean[] = [];
  const ch = {
    ack: (m: unknown) => void acks.push(m),
    reject: (_m: unknown, requeue?: boolean) => void rejects.push(Boolean(requeue)),
  } as unknown as Channel;
  return { ch, acks, rejects };
}
const msgOf = (env: object & { event_id: string }) =>
  ({
    content: Buffer.from(JSON.stringify(env)),
    properties: { messageId: env.event_id },
  }) as unknown as ConsumeMessage;
const tenantCreated = (tenant: string) =>
  createEvent({
    type: 'identity.tenant.created',
    tenantId: tenant,
    payload: { name: 'n', slug: 's' },
  });

describe('inbox (exactly-once effect on at-least-once delivery)', () => {
  it('I1 twenty concurrent deliveries of one event: one effect, one inbox row, twenty acks', async () => {
    const env = tenantCreated(A);
    const tag = `i1-${env.event_id}`;
    const { ch, acks, rejects } = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: ds,
      channel: ch,
      consumer: 'prop',
      handler: async (m, e) => {
        await m.query(`INSERT INTO "effects" ("tenant_id", "tag") VALUES ($1, $2)`, [
          e.tenant_id,
          tag,
        ]);
        await sleep(30);
      },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => consumer.onMessage(msgOf(env))),
    );
    expect(outcomes.filter((o) => o === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(19);
    expect(acks).toHaveLength(20);
    expect(rejects).toHaveLength(0);
    expect(await count(`SELECT count(*) AS n FROM effects WHERE tag = $1`, [tag])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM inbox WHERE event_id = $1`, [env.event_id])).toBe(
      1,
    );
  });

  it('I2 the inbox row and the effect commit together: a handler crash leaves neither, the redelivery applies once', async () => {
    const env = tenantCreated(A);
    const tag = `i2-${env.event_id}`;
    let crash = true;
    const { ch } = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: ds,
      channel: ch,
      consumer: 'prop',
      handler: async (m, e) => {
        await m.query(`INSERT INTO "effects" ("tenant_id", "tag") VALUES ($1, $2)`, [
          e.tenant_id,
          tag,
        ]);
        if (crash) throw new Error('crash after the effect, before commit');
      },
    });
    expect(await consumer.onMessage(msgOf(env))).toBe('rejected');
    expect(await count(`SELECT count(*) AS n FROM effects WHERE tag = $1`, [tag])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM inbox WHERE event_id = $1`, [env.event_id])).toBe(
      0,
    );
    crash = false;
    expect(await consumer.onMessage(msgOf(env))).toBe('applied');
    expect(await count(`SELECT count(*) AS n FROM effects WHERE tag = $1`, [tag])).toBe(1);
  });

  it('I3 FINDING: a transient handler failure is not dead-lettered on the first attempt', async () => {
    const { ch, rejects } = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: ds,
      channel: ch,
      consumer: 'prop',
      handler: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });
    await consumer.onMessage(msgOf(tenantCreated(A)));
    expect(rejects).not.toContain(false);
  });
});

// ---------------------------------------------------------------- idempotency
const call = (
  tenant: string,
  principal: string,
  key: string,
  body: unknown,
  tag: string,
  opts: { dsx?: DataSource; fail?: () => boolean; noBody?: boolean; holdMs?: number } = {},
) =>
  runWithTenant({ tenantId: tenant, principalId: principal }, () =>
    runIdempotent<{ tag: string } | undefined>({
      dataSource: opts.dsx ?? ds,
      principalId: principal,
      operation: 'prop.credit',
      key,
      request: body,
      effect: async (m) => {
        await m.query(`INSERT INTO "effects" ("tenant_id", "tag") VALUES ($1, $2)`, [tenant, tag]);
        await sleep(opts.holdMs ?? 20);
        if (opts.fail?.()) throw new Error('boom');
        return { status: opts.noBody ? 204 : 201, body: opts.noBody ? undefined : { tag } };
      },
    }),
  );
const effects = (tag: string) => count(`SELECT count(*) AS n FROM effects WHERE tag = $1`, [tag]);

describe('idempotency (runIdempotent)', () => {
  it('D1 twenty concurrent identical calls: one effect; the rest are 409 or a replay, never a 500', async () => {
    const key = `k-${uuidv7()}`;
    const tag = `d1-${key}`;
    const results = await Promise.allSettled(
      // Hold the first effect long enough that the others overlap it on every run.
      Array.from({ length: 20 }, () => call(A, 'p1', key, { amount: 5 }, tag, { holdMs: 300 })),
    );
    const other = results.filter(
      (r) => r.status === 'rejected' && !(r.reason instanceof IdempotencyInFlightError),
    );
    expect(other.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    for (const r of results) if (r.status === 'fulfilled') expect(r.value.body).toEqual({ tag });
    expect(await effects(tag)).toBe(1);
  });

  it('D2 the lock is released on error: a retry on another replica runs the effect, not 409', async () => {
    const key = `k-${uuidv7()}`;
    const tag = `d2-${key}`;
    await expect(call(A, 'p1', key, { amount: 5 }, tag, { fail: () => true })).rejects.toThrow(
      'boom',
    );
    const retry = await call(A, 'p1', key, { amount: 5 }, tag, { dsx: ds2 });
    expect(retry.replayed).toBe(false);
    expect(await effects(tag)).toBe(1);
  });

  it('D3 crash after the effect, before the record: nothing is committed', async () => {
    const key = `k-${uuidv7()}`;
    const tag = `d3-${key}`;
    // A body-less (204) result makes the record INSERT fail after the effect ran.
    await expect(call(A, 'p1', key, { amount: 5 }, tag, { noBody: true })).rejects.toThrow();
    expect(await effects(tag)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM idempotency_keys WHERE key = $1`, [key])).toBe(0);
  });

  it('D4 scope includes the tenant: the same principal, key and body in tenant B is a new call', async () => {
    const key = `k-${uuidv7()}`;
    const a = await call(A, 'p1', key, { amount: 5 }, `d4a-${key}`);
    const b = await call(B, 'p1', key, { amount: 5 }, `d4b-${key}`);
    expect([a.replayed, b.replayed]).toEqual([false, false]);
    expect(b.body).toEqual({ tag: `d4b-${key}` });
  });

  it('D5 scope includes the principal and 422 on a changed body without running the effect', async () => {
    const key = `k-${uuidv7()}`;
    const tag = `d5-${key}`;
    await call(A, 'p1', key, { amount: 5 }, tag);
    expect((await call(A, 'p2', key, { amount: 5 }, tag)).replayed).toBe(false);
    await expect(call(A, 'p1', key, { amount: 6 }, tag)).rejects.toBeInstanceOf(
      IdempotencyMismatchError,
    );
    expect(await effects(tag)).toBe(2);
  });

  it('D6 FINDING: an effect with no response body (204) can be made idempotent', async () => {
    const key = `k-${uuidv7()}`;
    const r = await call(A, 'p1', key, {}, `d6-${key}`, { noBody: true });
    expect(r.status).toBe(204);
  });
});

// ---------------------------------------------------------------- outbox
describe('outbox (enqueueEvent + OutboxRelay)', () => {
  let conn: ChannelModel;
  beforeAll(async () => {
    conn = await connect(AMQP);
  });
  afterAll(async () => {
    await conn?.close();
  });

  async function addRow(type: string): Promise<string> {
    const id = uuidv7();
    await ds.query(
      `INSERT INTO "outbox" ("event_id", "tenant_id", "type", "envelope") VALUES ($1, $2, $3, $4)`,
      [id, A, type, JSON.stringify({ event_id: id })],
    );
    await sleep(2); // distinct created_at
    return id;
  }

  async function drain(ch: Channel, queue: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const m = await ch.get(queue, { noAck: true });
      if (m) ids.push(String(m.properties.messageId));
      else await sleep(50);
    }
    return ids;
  }

  it('E1 FINDING: an event written under tenant A cannot carry tenant B', async () => {
    const err = await withTenantTransaction(
      ds,
      async (m) => {
        await enqueueEvent(m, tenantCreated(B));
        throw new Error('ENQUEUED');
      },
      A,
    ).catch((e: Error) => e);
    expect(err.message).not.toBe('ENQUEUED');
  });

  it('R1 FINDING: fifty unroutable rows do not starve a routable row behind them', async () => {
    const ch = await conn.createConfirmChannel();
    const routable = `prop.routable.${uuidv7()}`;
    const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    await ch.bindQueue(queue, EVENTS_EXCHANGE, routable);
    const stuck: string[] = [];
    for (let i = 0; i < 50; i++) stuck.push(await addRow(`prop.unroutable.${uuidv7()}`));
    const target = await addRow(routable);
    const relay = new OutboxRelay({ dataSource: ds, channel: ch });
    for (let i = 0; i < 5; i++) await relay.pollOnce();
    const [row] = await ds.query(`SELECT "published_at" FROM "outbox" WHERE "event_id" = $1`, [
      target,
    ]);
    await ds.query(`DELETE FROM "outbox" WHERE "event_id" = ANY($1::uuid[])`, [[...stuck, target]]);
    await ch.close();
    expect(row.published_at).not.toBeNull();
  });

  it('R2 relay crash between publish and mark: the row is republished (not lost) with the same message id', async () => {
    const ch1 = await conn.createConfirmChannel();
    const ch2 = await conn.createConfirmChannel();
    const routable = `prop.routable.${uuidv7()}`;
    const { queue } = await ch1.assertQueue('', { exclusive: true, autoDelete: true });
    await ch1.bindQueue(queue, EVENTS_EXCHANGE, routable);
    const id = await addRow(routable);
    const crashing = {
      transaction: (fn: (m: unknown) => Promise<unknown>) =>
        ds.transaction((m) =>
          fn(
            new Proxy(m, {
              get(t, p) {
                if (p === 'query')
                  return (sql: string, params?: unknown[]) =>
                    /UPDATE "outbox"/.test(sql)
                      ? Promise.reject(new Error('crash before mark'))
                      : t.query(sql, params);
                return (t as never)[p];
              },
            }),
          ),
        ),
    } as unknown as DataSource;
    await expect(
      new OutboxRelay({ dataSource: crashing, channel: ch2 }).pollOnce(),
    ).rejects.toThrow('crash before mark');
    const [still] = await ds.query(`SELECT "published_at" FROM "outbox" WHERE "event_id" = $1`, [
      id,
    ]);
    expect(still.published_at).toBeNull();
    expect(
      await new OutboxRelay({ dataSource: ds, channel: ch2 }).pollOnce(),
    ).toBeGreaterThanOrEqual(1);
    const ids = await drain(ch1, queue);
    expect(ids).toEqual([id, id]); // at-least-once: the duplicate carries the same id for the inbox
    await ch1.close();
    await ch2.close();
  });
});
