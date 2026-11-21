import { join } from 'node:path';
import { createDataSource } from '@ex-mio/service-kit';
import { TenantProjectionEntity } from './tenant-projection.entity';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

/** One factory serves the running app and the one-off migrate process. */
export const makeDataSource = () =>
  createDataSource({
    entities: [TenantProjectionEntity],
    migrations: [join(__dirname, 'migrations', `*.${ext}`)],
  });
