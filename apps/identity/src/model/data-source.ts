import { join } from 'node:path';
import { createDataSource } from '@ex-mio/service-kit';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

/**
 * One factory serves the running app and the one-off migrate process. Identity talks to Postgres
 * through plain SQL in the repositories (`pg-repos.ts`), so it registers no entities.
 */
export const makeDataSource = () =>
  createDataSource({
    entities: [],
    migrations: [join(__dirname, 'migrations', `*.${ext}`)],
  });
