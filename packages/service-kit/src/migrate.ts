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
 * Exit codes: 0 = migrations applied (or nothing to apply); 1 = failed (the
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
    const applied = await ds.runMigrations({ transaction: 'each' });
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
