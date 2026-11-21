import { Controller, Get, HttpException, Inject, Module, type DynamicModule } from '@nestjs/common';
import type { DependencyHealth, HealthCheck, HealthStatus } from '@ex-mio/contracts';
import { Public } from '@ex-mio/tenancy';

export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');

/** Named dependency probes: `{ db: () => ..., amqp: () => ... }`. */
export type HealthChecks = Record<string, () => Promise<DependencyHealth>>;

/** Time one probe; a throw becomes `down` with the message. */
export async function probe(fn: () => Promise<unknown>): Promise<DependencyHealth> {
  const startedAt = performance.now();
  try {
    await fn();
    return { status: 'ok', latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : 'health check failed',
    };
  }
}

function body(status: HealthStatus, checks: Record<string, DependencyHealth>): HealthCheck {
  return {
    status,
    uptime: process.uptime(),
    version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.1',
    gitSha: process.env.GIT_SHA,
    checks,
  };
}

/**
 * `/healthz/live`: the process is up, no dependencies consulted (a container
 * restart must not be triggered by a database outage).
 * `/healthz/ready`: every registered dependency answers; 503 otherwise (the
 * deploy plane gates traffic on this one).
 */
@Controller()
class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthChecks) {}

  @Public()
  @Get('/healthz/live')
  live(): HealthCheck {
    return body('ok', {});
  }

  @Public()
  @Get('/healthz/ready')
  async ready(): Promise<HealthCheck> {
    const entries = await Promise.all(
      Object.entries(this.checks).map(async ([name, check]) => [name, await check()] as const),
    );
    const checks = Object.fromEntries(entries);
    const down = entries.some(([, c]) => c.status !== 'ok');
    const result = body(down ? 'down' : 'ok', checks);
    if (down) throw new HttpException(result, 503);
    return result;
  }
}

@Module({})
export class HealthModule {
  /**
   * `inject` lists the providers (e.g. `Db`, `BusRuntime`) handed to `useFactory`,
   * which returns the named probes. The modules providing them must be imported
   * by `imports` here or be global.
   */
  static register(options: {
    imports?: DynamicModule['imports'];
    inject?: unknown[];
    useFactory: (...deps: never[]) => HealthChecks;
  }): DynamicModule {
    return {
      module: HealthModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_CHECKS,
          useFactory: options.useFactory,
          inject: (options.inject ?? []) as never[],
        },
      ],
    };
  }
}
