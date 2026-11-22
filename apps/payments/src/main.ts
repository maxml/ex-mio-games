import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger, setProductEventLogger } from '@ex-mio/logger';
import { failBootstrap, ReportingExceptionFilter } from '@ex-mio/service-kit';
import { createAppModule } from './app.module';
import { loadConfig } from './config';

const logger = createLogger({ name: 'payments' });
setProductEventLogger(logger); // product events carry service=payments

async function main(): Promise<void> {
  const config = loadConfig();
  // `rawBody: true` keeps the exact bytes of the provider webhook, which the signature covers.
  const app = await NestFactory.create<NestFastifyApplication>(
    createAppModule(config),
    new FastifyAdapter({ loggerInstance: logger }),
    { logger: ['error', 'warn', 'log'], bufferLogs: false, rawBody: true },
  );
  app.useGlobalFilters(new ReportingExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT }, 'listening');
}

main().catch((err) => failBootstrap(logger, err));
