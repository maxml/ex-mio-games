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
}

/** One factory serves the running app, the one-off migrate process and the tests. */
export const makeDataSource = (options: MakeDataSourceOptions = {}): DataSource => {
  const base = buildDataSourceOptions({
    entities: [],
    migrations: [join(__dirname, 'migrations', `*.${ext}`)],
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
