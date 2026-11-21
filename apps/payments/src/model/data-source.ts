import { join } from 'node:path';
import { createDataSource } from '@ex-mio/service-kit';
import { CoinCreditEntity } from './coin-credit.entity';

// `.ts` under tsx/ts-node, `.js` from the compiled dist: resolve either, next to this file.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

/** One factory serves the running app and the one-off migrate process. */
export const makeDataSource = () =>
  createDataSource({
    entities: [CoinCreditEntity],
    migrations: [join(__dirname, 'migrations', `*.${ext}`)],
  });
