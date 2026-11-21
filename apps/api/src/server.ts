import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppLogger } from '@ex-mio/logger';
import { createAppModule } from './app.module';
import { parseCorsOrigins } from './config/cors';
import type { AppDatabase } from './db';
import { ReportingExceptionFilter } from './common/reporting-exception.filter';
import { RealtimeIoAdapter, type RealtimeRedisClient } from './realtime';
import { createAppMetrics, MetricsHttpInterceptor } from './metrics';
import type { AppMetrics } from './metrics';
import type { AuthService } from './auth';

export interface BuildServerDeps {
  database: AppDatabase;
  auth: AuthService;
  corsOrigin: string;
  logLevel: string;
  /**
   * Structured (pino) logger used as Fastify's logger instance so request logs
   * are emitted in the Varta telemetry §3.1 shape (see @ex-mio/logger).
   * Omitted (e.g. in tests) falls back to a level-configured Fastify logger, or
   * no logger when `logLevel` is `silent`.
   */
  logger?: AppLogger;
  /** Enable the colocated socket.io realtime gateway (shares the HTTP server). */
  realtime?: boolean;
  /**
   * Raw Redis client (from the R1 `RedisCache` facade) for the realtime
   * adapter's cross-instance fan-out. `null`/omitted runs single-instance.
   */
  redisClient?: RealtimeRedisClient | null;
  /**
   * Varta app metrics (§2, OTLP push). Omitted → built from the environment via
   * `createAppMetrics()`, which is a disabled no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT`
   * is set. Tests inject an instance backed by an in-memory reader.
   */
  metrics?: AppMetrics;
}

// The realtime adapter created for a built app, keyed by the app instance. A
// WeakMap (not a property on `app`, which is a Proxy that rejects extra sets) so
// the shutdown path can reach the adapter to close the Redis client(s) it
// duplicated. See `getRealtimeAdapter`.
const realtimeAdapters = new WeakMap<object, RealtimeIoAdapter>();

/**
 * The realtime adapter wired into a built app, or `null` when realtime is
 * disabled. Used by the shutdown path to quit the adapter's duplicated Redis
 * subscriber client (which `disconnectCache()` does not own).
 */
export function getRealtimeAdapter(app: NestFastifyApplication): RealtimeIoAdapter | null {
  return realtimeAdapters.get(app) ?? null;
}

// The metrics surface wired into a built app (see `AppMetrics`). Kept in a WeakMap
// like the realtime adapter so the shutdown path can flush and stop the exporter.
const appMetrics = new WeakMap<object, AppMetrics>();

/** The {@link AppMetrics} wired into a built app, for the shutdown/flush path. */
export function getAppMetrics(app: NestFastifyApplication): AppMetrics | null {
  return appMetrics.get(app) ?? null;
}

export async function buildServer(deps: BuildServerDeps): Promise<NestFastifyApplication> {
  // Prefer the shared structured logger as Fastify's logger instance so HTTP
  // request logs conform to the telemetry §3.1 shape. When no logger is provided
  // (tests), fall back to a level-configured Fastify logger, or none if silent.
  const fastifyLoggerOption =
    deps.logger && deps.logLevel !== 'silent'
      ? { loggerInstance: deps.logger }
      : { logger: deps.logLevel === 'silent' ? false : { level: deps.logLevel } };

  const app = await NestFactory.create<NestFastifyApplication>(
    createAppModule({
      database: deps.database,
      auth: deps.auth,
      realtime: deps.realtime ?? false,
    }),
    new FastifyAdapter(fastifyLoggerOption),
    { logger: deps.logLevel === 'silent' ? false : ['error', 'warn', 'log'] },
  );

  app.useGlobalFilters(new ReportingExceptionFilter());

  // Varta app metrics (§2, OTLP push). Opt-in: `createAppMetrics()` only wires a
  // real OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise it is
  // a no-op and the interceptor is a pure passthrough, so the app runs as today.
  const metrics = deps.metrics ?? createAppMetrics();
  app.useGlobalInterceptors(new MetricsHttpInterceptor(metrics));
  metrics.start();
  appMetrics.set(app, metrics);

  // Shared parsing (see config/cors): a lone `*` reflects any origin (dev only -
  // the prod config guard rejects any wildcard), otherwise an explicit allow-list.
  const parsedOrigins = parseCorsOrigins(deps.corsOrigin);
  const origins = parsedOrigins === '*' ? true : parsedOrigins;
  app.enableCors({ origin: origins, credentials: true });

  if (deps.realtime) {
    // socket.io attaches to the same Fastify HTTP server, so the gateway shares
    // the app's port. The custom adapter applies the production CORS allow-list,
    // WebSocket-only transport, heartbeat, and the optional Redis backplane.
    const realtimeAdapter = new RealtimeIoAdapter(app, {
      corsOrigin: deps.corsOrigin,
      redisClient: deps.redisClient ?? null,
    });
    app.useWebSocketAdapter(realtimeAdapter);
    // Reachable from the shutdown path (`getRealtimeAdapter`): the adapter's
    // duplicated Redis subscriber is not closed by `disconnectCache()` and must
    // be quit explicitly.
    realtimeAdapters.set(app, realtimeAdapter);
  }

  const openApiConfig = new DocumentBuilder()
    .setTitle('ex-mio-games API')
    .setVersion('0.0.1')
    .addTag('health', 'Liveness and readiness')
    .addTag('users', 'Example CRUD on User model')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig), {
    jsonDocumentUrl: 'docs/json',
  });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
