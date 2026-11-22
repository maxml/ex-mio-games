import { join } from 'node:path';
import { DataSource, type Logger } from 'typeorm';
import { buildDataSourceOptions } from '@ex-mio/service-kit';
import { defaultPoolMax } from '../config';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

export interface MakeDataSourceOptions {
  /** Max connections of the pool. Default: `PG_POOL_MAX`, else 10. */
  poolMax?: number;
  /** Receives every statement sent through the pool (tests that inspect the SQL). */
  logger?: { logQuery(query: string): void };
  /** Connect as the owner (`MIGRATION_DATABASE_URL`) instead of `payments_app` (`DATABASE_URL`). */
  urlEnv?: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL';
}

const make = (options: MakeDataSourceOptions): DataSource => {
  const base = buildDataSourceOptions({
    entities: [],
    migrations: [join(__dirname, 'migrations', `*.${ext}`)],
    ...(options.urlEnv ? { urlEnv: options.urlEnv } : {}),
  });
  const sink = options.logger;
  const logger: Logger | undefined = sink && {
    logQuery: (query) => sink.logQuery(query),
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };
  return new DataSource({
    ...base,
    poolSize: options.poolMax ?? defaultPoolMax(),
    ...(logger ? { logger, logging: ['query'] as const } : {}),
  } as ConstructorParameters<typeof DataSource>[0]);
};

/** The running app and the tests: connects as `payments_app` (DATABASE_URL), which owns nothing. */
export const makeDataSource = (options: MakeDataSourceOptions = {}): DataSource => make(options);

/** The one-off migrate process: connects as `payments_owner` (MIGRATION_DATABASE_URL). */
export const makeMigrationDataSource = (): DataSource => make({ urlEnv: 'MIGRATION_DATABASE_URL' });
