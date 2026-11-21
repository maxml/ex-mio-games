// Opt-in OTLP tracing — MUST be the first import so the OTel instrumentations
// patch http/nest before those libraries load. A no-op returning a null handle
// unless OTEL_EXPORTER_OTLP_ENDPOINT is set (§5). See tracing/register.
import { tracingHandle } from './tracing/register';
import 'reflect-metadata';
import { createLogger } from '@ex-mio/logger';
import { loadConfig } from './config';
import { getAuthService } from './auth';
import { getDatabase, disconnectDatabase } from './db';
import { disconnectCache, getCache } from './redis';
import { buildServer, getAppMetrics, getRealtimeAdapter } from './server';
import { reportError } from './error-reporter';

// The app's structured logger (Varta telemetry §3.1). service/env/version and the
// level resolve from the environment (SERVICE_NAME/NODE_ENV/APP_VERSION/LOG_LEVEL);
// `name` sets the stable service identity when SERVICE_NAME is not injected.
const logger = createLogger({ name: 'ex-mio-api' });

async function main(): Promise<void> {
  const cfg = loadConfig();

  const database = getDatabase();
  await database.connect();

  const app = await buildServer({
    database,
    auth: getAuthService(database),
    corsOrigin: cfg.CORS_ORIGIN,
    logLevel: cfg.LOG_LEVEL,
    logger,
    realtime: true,
    // Reuse R1's optional Redis client for the socket.io backplane; null when
    // REDIS_URL is unset, so the gateway runs single-instance in dev.
    redisClient: getCache()?.client() ?? null,
  });

  await app.listen(cfg.PORT, '0.0.0.0');
  logger.info({ port: cfg.PORT }, 'listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown');
    await app.close();
    // Flush and stop the metrics exporter (no-op when metrics are disabled).
    await getAppMetrics(app)?.shutdown();
    await disconnectDatabase();
    // Quit the realtime adapter's duplicated Redis subscriber (null-safe when
    // realtime/Redis is off); `disconnectCache()` only closes the shared client.
    await getRealtimeAdapter(app)?.closeRedisClients();
    await disconnectCache();
    // Flush buffered spans before exit (no-op when tracing is disabled).
    await tracingHandle?.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Keep the ErrorReporter crash seam (D2: ConsoleReporter stays the default);
  // additionally emit a structured fatal line through the shared logger instead
  // of an ad-hoc console.error. pino's default stdout destination is synchronous,
  // so the line is flushed before the process exits.
  reportError(err, { phase: 'bootstrap' });
  logger.fatal({ err }, 'fatal bootstrap error');
  process.exit(1);
});
