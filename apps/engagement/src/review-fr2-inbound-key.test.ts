import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { QueryRunner } from 'typeorm';
import { InboundEventsEnvKey1733000001000 } from './model/migrations/1733000001000-InboundEventsEnvKey';

/*
 * Fix round 2 re-review, R2 (D-31): the inbound_events primary key change moved out of the applied
 * migration 1732800000000 into the forward migration 1733000001000. This runs that migration on a
 * real Postgres, on the two kinds of database that exist:
 *
 * FR2-MIG-1 a database that ran the RESTORED 1732800000000 (key (tenant_id, id), with rows of both
 *   environments): the key becomes (tenant_id, sandbox, id) and no row is lost.
 * FR2-MIG-2 a database that ran the EDITED 1732800000000 (int/final 2736a6e..dd9d464; key already
 *   (tenant_id, sandbox, id)): the migration is a no-op, and running it twice is a no-op.
 *   Mutation: drop the early return -> FR2-MIG-2 still green (DROP + ADD the same key), so the guard is
 *   an optimisation, not a correctness condition; reported, not a defect.
 *
 * Needs `REVIEW_PG_URL` (a superuser URL of a throwaway Postgres); skipped without it, and says so.
 */

const url = process.env.REVIEW_PG_URL;
const run = url ? describe : describe.skip;
if (!url) {
  // eslint-disable-next-line no-console
  console.warn('review-fr2-inbound-key: REVIEW_PG_URL not set, suite skipped');
}

const SCHEMA = `fr2m_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

run('fix round 2: forward migration of the inbound_events key (R2)', () => {
  let pg: Client;
  const runner = () =>
    ({
      query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows,
    }) as unknown as QueryRunner;
  const pk = async (): Promise<string> =>
    (
      await pg.query(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
           FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = 'inbound_events'::regclass AND i.indisprimary`,
      )
    ).rows[0].cols.join(',');
  const create = async (key: string) => {
    await pg.query(`DROP TABLE IF EXISTS "inbound_events"`);
    await pg.query(
      `CREATE TABLE "inbound_events" ("id" uuid NOT NULL, "tenant_id" uuid NOT NULL,
         "sandbox" boolean NOT NULL, "source" text NOT NULL, "external_event_id" text NOT NULL,
         CONSTRAINT "inbound_events_pkey" PRIMARY KEY (${key}),
         UNIQUE ("tenant_id", "sandbox", "source", "external_event_id"))`,
    );
    const t = randomUUID();
    for (const sandbox of [false, true]) {
      await pg.query(`INSERT INTO "inbound_events" VALUES ($1, $2, $3, 'casino-a', $4)`, [
        randomUUID(),
        t,
        sandbox,
        `e-${sandbox}`,
      ]);
    }
  };
  const rows = async (): Promise<number> =>
    (await pg.query(`SELECT count(*)::int AS n FROM "inbound_events"`)).rows[0].n as number;

  beforeAll(async () => {
    pg = new Client({ connectionString: url });
    await pg.connect();
    await pg.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pg.query(`SET search_path = "${SCHEMA}"`);
  });
  afterAll(async () => {
    await pg.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await pg.end();
  });

  it('FR2-MIG-1 a database on the restored 1732800000000 gets the environment in its key, no row lost', async () => {
    await create(`"tenant_id", "id"`);
    expect(await pk()).toBe('tenant_id,id');
    await new InboundEventsEnvKey1733000001000().up(runner());
    expect({ pk: await pk(), rows: await rows() }).toEqual({ pk: 'tenant_id,sandbox,id', rows: 2 });
  });

  it('FR2-MIG-2 a database on the edited 1732800000000 is left alone, twice', async () => {
    await create(`"tenant_id", "sandbox", "id"`);
    await new InboundEventsEnvKey1733000001000().up(runner());
    await new InboundEventsEnvKey1733000001000().up(runner());
    expect({ pk: await pk(), rows: await rows() }).toEqual({ pk: 'tenant_id,sandbox,id', rows: 2 });
  });
});
