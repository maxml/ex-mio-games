import { DataSource, type EntityManager } from 'typeorm';
import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { afterCommit } from '@ex-mio/logger';
import { RealtimeGateway } from './realtime.gateway';

/*
 * rc review (test owner), item 4: the after-commit unification on a REAL TypeORM transaction.
 *
 * The merge (a83c8be) replaced the gateway's own PostCommitPushes with the logger's `afterCommit`,
 * whose subscriber ignores a commit/rollback event while `queryRunner.isTransactionActive` is still
 * true, and changed the FAKE runner of realtime.gateway.test to set that flag to false before firing.
 * A fake cannot tell whether that matches TypeORM. This file runs against Postgres (the compose
 * database, any role) with typeorm 0.3.x's real PostgresQueryRunner:
 *   DATABASE_URL=postgresql://engagement_app:engagement-app-dev@localhost:54329/engagement \
 *     pnpm --filter @ex-mio/engagement test:pg -- review-rc-after-commit
 *
 * The exit of a push is `RealtimeGateway.publish` (spied); the exit of a product event is the effect
 * handed to `afterCommit`. "After commit" is checked from ANOTHER connection: when the effect runs it
 * asks Postgres for `txid_status` of the transaction, which must already be `committed`.
 *
 * Mutations (re-applied by the reviewer):
 *  - `afterCommit` runs the effect at once (no subscriber)               -> AC-1 red (status `in progress`), AC-2 red.
 *  - the commit subscriber drops the `isTransactionActive` check        -> AC-3 red (fires at RELEASE SAVEPOINT).
 * RED today: AC-4 (an effect queued inside a savepoint that was ROLLED BACK still leaves when the
 * outer transaction commits: the rollback subscriber returns early while the outer transaction is
 * active, and the effect stays in the runner's list).
 */
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the after-commit run');

let ds: DataSource;
/** Another pooled connection (never the transaction's own runner). */
const side = {
  query: async (sql: string, params: unknown[]) => ({
    rows: (await ds.query(sql, params)) as Array<{ s: string }>,
  }),
};

beforeAll(async () => {
  ds = await new DataSource({ type: 'postgres', url: process.env.DATABASE_URL }).initialize();
});
afterAll(async () => {
  await ds?.destroy();
});

const event = (): EventEnvelope =>
  ({
    event_id: uuidv7(),
    type: 'engagement.spin.completed',
    version: 1,
    tenant_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    payload: { spin_id: uuidv7(), player_id: uuidv7(), reward_coins: 5, table_version: 1 },
  }) as unknown as EventEnvelope;

function gateway() {
  const gw = new RealtimeGateway({} as never, {} as never, {} as never);
  const published: string[] = [];
  jest
    .spyOn(gw, 'publish')
    .mockImplementation((e: EventEnvelope) => void published.push(e.event_id));
  return { gw, published };
}

/** An effect that records, from another connection, the status of `xid()` at the moment it ran. */
function probe(xid: () => string) {
  const statuses: Array<Promise<string>> = [];
  const effect = () => {
    statuses.push(
      side.query('SELECT txid_status($1::bigint) AS s', [xid()]).then((r) => r.rows[0]!.s),
    );
  };
  return { effect, statuses };
}

const txid = async (m: EntityManager): Promise<string> =>
  ((await m.query('SELECT txid_current()::text AS x')) as Array<{ x: string }>)[0]!.x;

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('rc review: afterCommit on a real TypeORM transaction (pushes and product events)', () => {
  it('AC-1 commit: the push and the product event leave exactly once, and only after COMMIT', async () => {
    const { gw, published } = gateway();
    let xid = '';
    const p = probe(() => xid);
    const e = event();
    await ds.transaction(async (m) => {
      xid = await txid(m);
      gw.queue(m, e);
      afterCommit(m, p.effect);
      // anything that already ran inside the transaction sees it in progress
      expect(await Promise.all(p.statuses)).toEqual([]);
      expect(published).toEqual([]);
    });
    expect(published).toEqual([e.event_id]);
    expect(await Promise.all(p.statuses)).toEqual(['committed']);
    await settle();
    expect(published).toHaveLength(1);
  });

  it('AC-2 rollback: nothing leaves', async () => {
    const { gw, published } = gateway();
    const p = probe(() => '0');
    await expect(
      ds.transaction(async (m) => {
        gw.queue(m, event());
        afterCommit(m, p.effect);
        await m.query('SELECT 1/0');
      }),
    ).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
    expect(p.statuses).toHaveLength(0);
  });

  it('AC-3 nested: a released savepoint is not the commit; the effect leaves once, at the outer COMMIT', async () => {
    const { gw, published } = gateway();
    let xid = '';
    const p = probe(() => xid);
    const e = event();
    await ds.transaction(async (outer) => {
      xid = await txid(outer);
      await outer.transaction(async (inner) => {
        gw.queue(inner, e);
        afterCommit(inner, p.effect);
      }); // RELEASE SAVEPOINT
      expect(published).toEqual([]);
      expect(p.statuses).toHaveLength(0);
    });
    expect(published).toEqual([e.event_id]);
    expect(await Promise.all(p.statuses)).toEqual(['committed']);
  });

  it('AC-4 a savepoint rolled back, then the outer COMMIT: what was queued inside the savepoint never leaves', async () => {
    const { gw, published } = gateway();
    const inside = event();
    const outside = event();
    const p = probe(() => '0');
    await ds.transaction(async (outer) => {
      await outer
        .transaction(async (inner) => {
          gw.queue(inner, inside);
          afterCommit(inner, p.effect);
          await inner.query('SELECT 1/0');
        })
        .catch(() => undefined); // ROLLBACK TO SAVEPOINT; the outer transaction goes on
      gw.queue(outer, outside);
    });
    await settle();
    expect(published).toEqual([outside.event_id]);
    expect(p.statuses).toHaveLength(0);
  });

  it('AC-5 outer rollback after a released savepoint: nothing leaves', async () => {
    const { gw, published } = gateway();
    await expect(
      ds.transaction(async (outer) => {
        await outer.transaction(async (inner) => gw.queue(inner, event()));
        await outer.query('SELECT 1/0');
      }),
    ).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('AC-6 a COMMIT that fails (deferred constraint) sends nothing', async () => {
    const { gw, published } = gateway();
    await expect(
      ds.transaction(async (m) => {
        await m.query(
          `CREATE TEMP TABLE rc_review_deferred (id int UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP`,
        );
        await m.query('INSERT INTO rc_review_deferred VALUES (1), (1)');
        gw.queue(m, event());
      }),
    ).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });
});
