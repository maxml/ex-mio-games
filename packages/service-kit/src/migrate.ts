import type { DataSource } from 'typeorm';

/**
 * Body of a service's `migrate.js` entry point. The runtime image has no pnpm
 * and no TypeORM CLI, only `node`, so deploy runs
 * `node dist/migrate.js` as a one-off step before starting the new version.
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
  try {
    ds = dataSource();
    await ds.initialize();
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
    if (ds?.isInitialized) await ds.destroy();
  }
}
