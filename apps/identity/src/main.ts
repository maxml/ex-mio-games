import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger, setProductEventLogger } from '@ex-mio/logger';
import { failBootstrap } from '@ex-mio/service-kit';
import { createAppModule } from './app.module';
import { loadConfig } from './config';
import { IdentityExceptionFilter } from './controllers';

const logger = createLogger({ name: 'identity' });
setProductEventLogger(logger); // product events carry service=identity

async function main(): Promise<void> {
  const config = loadConfig();
  // Not `startService`: identity answers with `IdentityErrorBody` through its own exception filter.
  const app = await NestFactory.create<NestFastifyApplication>(
    createAppModule(config),
    new FastifyAdapter({ loggerInstance: logger }),
    { logger: ['error', 'warn', 'log'], bufferLogs: false },
  );
  app.useGlobalFilters(new IdentityExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT }, 'listening');
}

main().catch((err) => failBootstrap(logger, err));
