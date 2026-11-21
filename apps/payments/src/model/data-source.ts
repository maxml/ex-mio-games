import { join } from 'node:path';
import { createDataSource } from '@ex-mio/service-kit';
import { CoinCreditEntity } from './coin-credit.entity';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

const options = {
  entities: [CoinCreditEntity],
  migrations: [join(__dirname, 'migrations', `*.${ext}`)],
};

/** The running app: connects as `payments_app` (DATABASE_URL), which owns nothing. */
export const makeDataSource = () => createDataSource(options);

/** The one-off migrate process: connects as `payments_owner` (MIGRATION_DATABASE_URL). */
export const makeMigrationDataSource = () =>
  createDataSource({ ...options, urlEnv: 'MIGRATION_DATABASE_URL' });
