import { join } from 'node:path';
import { createDataSource } from '@ex-mio/service-kit';
import { TenantProjectionEntity } from './tenant-projection.entity';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

const options = {
  entities: [TenantProjectionEntity],
  migrations: [join(__dirname, 'migrations', `*.${ext}`)],
};

/** The running app: connects as `engagement_app` (DATABASE_URL), which owns nothing. */
export const makeDataSource = () => createDataSource(options);

/** The one-off migrate process: connects as `engagement_owner` (MIGRATION_DATABASE_URL). */
export const makeMigrationDataSource = () =>
  createDataSource({ ...options, urlEnv: 'MIGRATION_DATABASE_URL' });
