import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { connect } from 'amqplib';
import { Credit, TenantProjection, uuidv7 } from '@ex-mio/contracts';
import { eventually, pgAs, PLATFORM_TOKEN, rabbitApi, urls } from './env';

const sh = promisify(execFile);
const repoRoot = resolve(__dirname, '../../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ready = async (base: string): Promise<number> => {
  try {
    return (await fetch(`${base}/healthz/ready`)).status;
  } catch {
    return 0;
  }
};

describe('broker connection loss (F-BUS-2)', () => {
  it('after every broker connection is closed the services report it, reconnect by themselves and deliver again', async () => {
    const services = [urls.identity, urls.engagement, urls.payments];
    expect(await Promise.all(services.map(ready))).toEqual([200, 200, 200]);

    // Close every connection from the broker side, like a broker restart would.
    const list = await rabbitApi('/connections');
    const connections = (await list.json()) as { name: string }[];
    expect(connections.length).toBeGreaterThan(0);
    for (const c of connections) {
      await rabbitApi(`/connections/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
    }

    // Honest while down: at least one service says 503 at some point (not required to be
    // observed, the reconnect can win the race), but all of them must be ready again, with
    // no process restart.
    await eventually(async () => {
      const codes = await Promise.all(services.map(ready));
      return codes.every((c) => c === 200) ? true : undefined;
    }, 60_000);

    // And the relay and the consumer work again: identity -> broker -> engagement.
    const slug = `recover-${uuidv7().slice(-12)}`;
    const res = await fetch(`${urls.identity}/v1/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-platform-admin-token': PLATFORM_TOKEN },
      body: JSON.stringify({ name: `Recover ${slug}`, slug }),
    });
    expect(res.status).toBe(201);
    const tenant = (await res.json()) as { id: string };
    const projection = await eventually(async () => {
      const r = await fetch(`${urls.engagement}/v1/tenant-projection`, {
        headers: { 'x-tenant-id': tenant.id },
      });
      return r.status === 200 ? TenantProjection.parse(await r.json()) : undefined;
    }, 30_000);
    expect(projection).toMatchObject({ tenant_id: tenant.id, applied_count: 1 });
  }, 120_000);
});

describe('outbox: an event nobody consumes yet (F-BUS-1)', () => {
  it('is retried with a growing delay per row, not republished in a loop', async () => {
    const tenant = uuidv7();
    const res = await fetch(`${urls.payments}/v1/credits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant,
        'x-principal-id': 'op-1',
        'idempotency-key': `key-${uuidv7()}`,
      },
      body: JSON.stringify({ player_id: uuidv7(), amount: 3 }),
    });
    expect(res.status).toBe(201);
    const credit = Credit.parse(await res.json());
    const db = await pgAs('payments_app');
    try {
      const row = () =>
        db.query(
          `SELECT o.attempts, o.published_at, o.parked_at, o.next_attempt_at > now() AS delayed
             FROM outbox o WHERE o.envelope->'payload'->>'credit_id' = $1`,
          [credit.id],
        );
      // payments.coins.credited has no consumer: the broker returns it, the row backs off.
      const first = await eventually(async () => {
        const { rows } = await row();
        return rows[0]?.attempts >= 1 ? rows[0] : undefined;
      }, 15_000);
      expect(first.published_at).toBeNull();
      expect(first.delayed).toBe(true);
      await sleep(6_000);
      const { rows } = await row();
      // A hot loop (the old behaviour: ~11 republishes per second) would be far above this.
      expect(rows[0].attempts).toBeLessThanOrEqual(3);
      expect(rows[0].parked_at).toBeNull();
    } finally {
      await db.end();
    }
  }, 60_000);
});

describe('dead-letter queue and replay (F-BUS-3)', () => {
  it('a permanent failure is dead-lettered once, and the replay command moves it back', async () => {
    const conn = await connect(urls.amqp);
    const ch = await conn.createConfirmChannel();
    try {
      await ch.purgeQueue('engagement.dlq');
      ch.publish(
        'mio.events',
        'identity.tenant.created',
        Buffer.from(JSON.stringify({ not: 'an envelope' })),
        { persistent: true, mandatory: true },
      );
      await ch.waitForConfirms();
      await eventually(async () =>
        (await ch.checkQueue('engagement.dlq')).messageCount === 1 ? true : undefined,
      );

      const run = (...args: string[]) =>
        sh(
          'docker',
          ['compose', 'exec', '-T', 'engagement', 'node', 'dist/dlq-replay.js', ...args],
          {
            cwd: repoRoot,
          },
        );
      const dry = await run('--dry-run');
      expect(dry.stdout).toContain('engagement.dlq: 1 message(s) waiting');
      expect((await ch.checkQueue('engagement.dlq')).messageCount).toBe(1); // a dry run moves nothing

      const replay = await run();
      expect(replay.stdout).toContain('engagement.dlq: 1 waiting, 1 replayed');
      // The message is invalid, so the consumer dead-letters it again: the round trip is the proof.
      await eventually(async () =>
        (await ch.checkQueue('engagement.dlq')).messageCount === 1 ? true : undefined,
      );
      expect((await ch.checkQueue('engagement.events')).messageCount).toBe(0);
    } finally {
      await ch.purgeQueue('engagement.dlq').catch(() => undefined);
      await ch.close().catch(() => undefined);
      await conn.close().catch(() => undefined);
    }
  }, 90_000);
});
