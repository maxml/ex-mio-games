import 'reflect-metadata';
import { createLogger } from '@ex-mio/logger';
import { createService, failBootstrap } from '@ex-mio/service-kit';
import { createAppModule } from './app.module';
import { loadConfig } from './config';
import { registerRawJsonParser } from './controllers/ingest.controller';

const logger = createLogger({ name: 'engagement' });

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createService({ module: createAppModule(config), logger });
  // The webhook signature covers the exact body bytes: the ingest route reads the raw string.
  registerRawJsonParser(app.getHttpAdapter().getInstance());
  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT }, 'listening');
}

main().catch((err) => failBootstrap(logger, err));
