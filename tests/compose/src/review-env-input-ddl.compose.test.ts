import { pgAs } from './env';

/*
 * D-29 INV-ENV-INPUT-7 (docs/specs/env-input.md 3.5, section 4), the catalog half: no environment
 * column (`sandbox`, `environment`) in any service database keeps a column DEFAULT, so a writer that
 * forgets the column fails instead of getting production. The migration-history half is
 * INV-ENV-INPUT-7a (packages/service-kit/src/review-env-input.test.ts): a backfill DEFAULT is allowed
 * in the migration that adds a column to a table with rows ONLY if a later migration drops it.
 * The allow-list below is empty by that decision: the final schema has no exception.
 *
 * RED until the drop-default migrations land (today: 8 columns, see 7a). Compose-only.
 * Mutation: a new migration that re-adds `DEFAULT false` to any environment column -> red.
 */

const ENV_COLUMNS = ['sandbox', 'environment'];
const ALLOWED: Record<string, string> = {};

describe.each(['identity', 'engagement', 'payments'] as const)(
  'INV-ENV-INPUT-7 %s database: no DEFAULT on an environment column',
  (service) => {
    it('INV-ENV-INPUT-7b the catalog shows environment columns and none of them has a default', async () => {
      const db = await pgAs('postgres', service);
      try {
        const cols = await db.query(
          `SELECT c.relname AS t, a.attname AS col
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE a.attname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped`,
          [ENV_COLUMNS],
        );
        expect(cols.rowCount).toBeGreaterThan(0); // the scan sees the scoped tables
        const defaults = await db.query(
          `SELECT c.relname AS t, a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS def
             FROM pg_attrdef d
             JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
             JOIN pg_class c ON c.oid = d.adrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE a.attname = ANY($1) AND NOT a.attisdropped`,
          [ENV_COLUMNS],
        );
        const offending = defaults.rows
          .map((r) => `${r.t}.${r.col} DEFAULT ${r.def}`)
          .filter((s) => !(s.split(' ')[0]! in ALLOWED));
        expect(offending).toEqual([]);
      } finally {
        await db.end();
      }
    });
  },
);
