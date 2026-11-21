import 'reflect-metadata';
import { createLogger } from '@ex-mio/logger';
import { failBootstrap, startService } from '@ex-mio/service-kit';
import { createAppModule } from './app.module';import { loadConfig } from './config';

const logger = createLogger({ name: 'identity' });

async function main(): Promise<void> {
  const config = loadConfig();
  await startService({ module: createAppModule(config), port: config.PORT, logger });
}

main().catch((err) => failBootstrap(logger, err));
