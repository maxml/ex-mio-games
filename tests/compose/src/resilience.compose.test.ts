import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { connect } from 'amqplib';
import { TenantProjection, uuidv7 } from '@ex-mio/contracts';
import { eventually, pgAs, rabbitApi, urls } from './env';
import { newTenant } from './player-session';
import { seedCoins } from './seed-coins';

/*
 * D-24 (int/all review): these tests used the removed `POST /v1/tenants` (platform header) and the
 * removed payments `POST /v1/credits`. They now use today's real routes: operator signup for a tenant
 * (identity -> broker -> engagement), and a player redemption for an event nobody consumes
 * (`engagement.redemption.status_changed` to REQUESTED, written by engagement's outbox in the order
 * transaction; the real store writes no `redemption.requested`).
 * The properties are the same: the relay and the consumer recover after the broker drops every
 * connection; an unroutable outbox row backs off per row instead of being republished in a loop.
 */

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

    // And the relay and the consumer work again: identity -> broker -> engagement. The tenant comes
    // from a real operator signup (D-24); the projection is read with the operator's own token.
    const tenant = await newTenant();
    const operator = await tenant.operatorHeaders('engagement');
    const projection = await eventually(async () => {
      const r = await fetch(`${urls.engagement}/v1/tenant-projection`, { headers: operator });
      return r.status === 200 ? TenantProjection.parse(await r.json()) : undefined;
    }, 30_000);
    expect(projection).toMatchObject({ tenant_id: tenant.tenantId, applied_count: 1 });
  }, 120_000);
});

describe('outbox: an event nobody consumes yet (F-BUS-1)', () => {
  // rc review: feat/realtime binds `engagement.redemption.status_changed` (the gateway pushes it), and
  // the precondition below caught it. The outcome events of a redemption still have no consumer; the
  // redemption ends in exactly one of them (issued, rejected or needs_review), whichever the casino
  // simulator answers, so the test follows whichever row this redemption wrote.
  const UNCONSUMED = [
    'engagement.redemption.issued',
    'engagement.redemption.rejected',
    'engagement.redemption.needs_review',
  ];

  it('is retried with a growing delay per row, not republished in a loop', async () => {
    // Precondition, checked rather than assumed: no queue is bound to the event (a topic binding
    // with a wildcard counts). If a consumer appears one day, this says so instead of going vacuous.
    const bindings = (await (
      await rabbitApi('/exchanges/%2F/mio.events/bindings/source')
    ).json()) as { routing_key: string }[];
    const matches = (pattern: string) =>
      UNCONSUMED.some((type) =>
        new RegExp(
          `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+').replace(/#/g, '.*')}$`,
        ).test(type),
      );
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.filter((b) => matches(b.routing_key))).toEqual([]);

    // A real redemption: operator item, a funded player (D-1 seeding), the player redeems.
    const tenant = await newTenant();
    const operator = await tenant.operatorHeaders('engagement');
    const item = await fetch(`${urls.engagement}/v1/store/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...operator },
      body: JSON.stringify({
        name: 'Spins',
        price: 10,
        stock: 5,
        reward: { type: 'free_spins', params: { count: 10 } },
      }),
    });
    expect(item.status).toBe(201);
    const { id: itemId } = (await item.json()) as { id: string };
    const player = await tenant.player();
    await seedCoins(tenant.tenantId, player.userId, 100, {
      operatorToken: await tenant.operatorToken('payments'),
    });
    const redeemed = await fetch(`${urls.engagement}/v1/redemptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...player.headers,
        'idempotency-key': `key-${uuidv7()}`,
      },
      body: JSON.stringify({ item_id: itemId }),
    });
    expect(redeemed.status).toBe(202);
    const { id: redemptionId } = (await redeemed.json()) as { id: string };

    const db = await pgAs('engagement_app');
    try {
      const row = () =>
        db.query(
          `SELECT o.attempts, o.published_at, o.parked_at, o.next_attempt_at > now() AS delayed
             FROM outbox o WHERE o.type = ANY($1) AND o.envelope->'payload'->>'redemption_id' = $2`,
          [UNCONSUMED, redemptionId],
        );
      // nobody is bound to it: the broker returns it, the row backs off.
      const first = await eventually(async () => {
        const { rows } = await row();
        return rows[0]?.attempts >= 1 ? rows[0] : undefined;
      }, 30_000);
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
