import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppLogger } from '@ex-mio/logger';
import { reportError } from './error-reporter';
import { ReportingExceptionFilter } from './reporting-exception.filter';

export interface BootstrapOptions {
  module: Type<unknown> | DynamicModule;
  port: number;
  logger: AppLogger;
}

/**
 * Create the Nest app on Fastify with the shared pino logger, the exception
 * filter that never leaks internals, and shutdown hooks (SIGTERM closes the app,
 * which runs every module's `onModuleDestroy`: relays stop, pools close).
 */
export async function createService(
  options: Pick<BootstrapOptions, 'module' | 'logger'>,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    options.module,
    new FastifyAdapter({ loggerInstance: options.logger }),
    { logger: ['error', 'warn', 'log'], bufferLogs: false },
  );
  app.useGlobalFilters(new ReportingExceptionFilter());
  app.enableShutdownHooks();
  return app;
}

export async function startService(options: BootstrapOptions): Promise<NestFastifyApplication> {
  const app = await createService(options);
  await app.listen(options.port, '0.0.0.0');
  options.logger.info({ port: options.port }, 'listening');
  return app;
}

/** Last-resort handler for `main().catch(...)`: report, log, exit 1. */
export function failBootstrap(logger: AppLogger, err: unknown): never {
  reportError(err, { phase: 'bootstrap' });
  logger.fatal({ err }, 'fatal bootstrap error');
  process.exit(1);
}
