import { join } from 'node:path';
import { createDataSource } from '@ex-mio/service-kit';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

// Identity talks to Postgres through plain SQL in the repositories (`pg-repos.ts`), so it registers
// no entities.
const options = {
  entities: [],
  migrations: [join(__dirname, 'migrations', `*.${ext}`)],
};

/** The running app: connects as `identity_app` (DATABASE_URL), which owns nothing. */
export const makeDataSource = () => createDataSource(options);

/** The one-off migrate process: connects as `identity_owner` (MIGRATION_DATABASE_URL). */
export const makeMigrationDataSource = () =>
  createDataSource({ ...options, urlEnv: 'MIGRATION_DATABASE_URL' });
