import type { DataSource, QueryRunner } from 'typeorm';

/**
 * The advisory-lock id for "a migration run is in progress". Advisory locks are
 * per database and every service has its own, so services never wait on each other.
 */
export const MIGRATION_LOCK_ID = 7_300_000_001;

/**
 * Body of a service's `migrate.js` entry point. The runtime image has no pnpm
 * and no TypeORM CLI, only `node`, so deploy runs
 * `node dist/migrate.js` as a one-off step before starting the new version.
 *
 * TypeORM takes no migration lock of its own, so two replicas starting at once
 * on a fresh database raced (`duplicate key ... pg_type_typname_nsp_index`). The
 * run holds a session-level advisory lock on a dedicated connection: the second
 * replica waits for the first to finish, then finds nothing to apply and exits 0.
 *
 * It runs as the migration (owner) role: see `DataSourceInput.urlEnv`.
 *
 * Exit codes: 0 = every shipped migration is applied (this run or an earlier one); 1 = failed,
 * including "no migrations shipped" and "some still pending after the run" (the
 * message is on stderr; the database is left as TypeORM's per-migration
 * transaction left it). The deploy must stop on a non-zero exit.
 */
export async function runMigrationsCli(
  dataSource: () => DataSource,
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<number> {
  let ds: DataSource | undefined;
  let lockConnection: QueryRunner | undefined;
  try {
    ds = dataSource();
    await ds.initialize();
    // Its own connection: the lock must outlive TypeORM's per-migration transactions.
    lockConnection = ds.createQueryRunner();
    await lockConnection.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    // Pre-condition: the image ships migrations. A missing `dist/model/migrations` makes the data
    // source glob match nothing, and "nothing to apply" would then be a green deploy of an empty schema.
    // A real DataSource always has `migrations` and `showMigrations`; they are read as optional only
    // so the minimal double of the lock-order test (ops.test.ts) keeps working. An empty list fails.
    const source = ds as Partial<Pick<DataSource, 'migrations' | 'showMigrations'>>;
    const shipped = source.migrations?.length;
    if (shipped === 0) {
      throw new Error(
        'no migrations are shipped in this image (is dist/model/migrations missing?)',
      );
    }
    const applied = await ds.runMigrations({ transaction: 'each' });
    // Post-condition: the applied set equals the shipped set. `showMigrations` is true while any
    // shipped migration is still pending.
    if (source.showMigrations && (await ds.showMigrations())) {
      throw new Error(`migrations left pending after the run (${shipped} shipped)`);
    }
    log(
      applied.length === 0
        ? 'migrations: nothing to apply'
        : `migrations: applied ${applied.map((m) => m.name).join(', ')}`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `migrations failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    // Releasing the connection to the pool; destroy() then closes it, which frees the lock.
    await lockConnection?.release().catch(() => undefined);
    if (ds?.isInitialized) await ds.destroy();
  }
}
