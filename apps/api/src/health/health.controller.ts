import { Controller, Get, HttpException, Inject } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { DependencyHealth, HealthCheck, HealthStatus } from '@ex-mio/shared-types';
import { DATABASE } from '../app.tokens';
import type { AppDatabase } from '../db';
import { checkRedisHealth } from '../redis';
import { healthCheckOpenApiSchema } from '../common/openapi';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: AppDatabase) {}

  @Get('/healthz/live')
  @ApiResponse({ status: 200, schema: healthCheckOpenApiSchema })
  live(): HealthCheck {
    return healthBody('ok', {});
  }

  @Get('/healthz/ready')
  @ApiResponse({ status: 200, schema: healthCheckOpenApiSchema })
  @ApiResponse({ status: 503, schema: healthCheckOpenApiSchema })
  async ready(): Promise<HealthCheck> {
    const db = await checkDatabase(this.database);
    const body = healthBody(db.status === 'ok' ? 'ok' : 'down', { db });

    if (db.status !== 'ok') {
      throw new HttpException(body, 503);
    }

    return body;
  }

  @Get('/healthz')
  @ApiResponse({ status: 200, schema: healthCheckOpenApiSchema })
  @ApiResponse({ status: 503, schema: healthCheckOpenApiSchema })
  async health(): Promise<HealthCheck> {
    const db = await checkDatabase(this.database);
    const redis = await checkRedisHealth();
    const checks: Record<string, DependencyHealth> = {
      db,
      ...(redis ? { redis } : {}),
    };
    const requiredDown = db.status !== 'ok';
    const degraded = requiredDown || (redis !== null && redis.status !== 'ok');
    const body = healthBody(degraded ? (requiredDown ? 'down' : 'degraded') : 'ok', checks);
    // Redis is optional for readiness by default.

    if (requiredDown) {
      throw new HttpException(body, 503);
    }

    return body;
  }
}

async function checkDatabase(database: AppDatabase): Promise<DependencyHealth> {
  const startedAt = performance.now();

  try {
    const status = await database.ping();
    return {
      status,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (err: unknown) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : 'Database health check failed',
    };
  }
}

function healthBody(status: HealthStatus, checks: Record<string, DependencyHealth>): HealthCheck {
  return {
    status,
    uptime: process.uptime(),
    version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.1',
    // Immutable commit id injected by the deploy plane (Deckhand) as GIT_SHA.
    // Absent (undefined -> omitted from JSON) when running without it.
    gitSha: process.env.GIT_SHA,
    checks,
  };
}
