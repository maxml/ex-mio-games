import 'dotenv/config';
import { createLogger } from '@ex-mio/logger';
import { buildServer } from './server';

const logger = createLogger({ name: 'casino-sim' });
const port = Number(process.env.PORT ?? 4004);

const app = buildServer({
  logger,
  keyA: process.env.CASINO_A_KEY,
  secretB: process.env.CASINO_B_SECRET,
});

const shutdown = (): void => void app.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  logger.fatal({ err }, 'fatal bootstrap error');
  process.exit(1);
});
