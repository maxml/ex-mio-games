import { Redis } from 'ioredis';

/**
 * Structurally compatible with `DependencyHealth` from `@ex-mio/contracts`
 * without coupling the facade to the wire schema. The health module maps this
 * into the `/healthz` `checks` record.
 */
export interface RedisHealth {
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  error?: string;
}

/**
 * Typed Redis facade — the only place that imports `ioredis`. Consumers depend
 * on this interface (cache get/set/del, pub/sub via the raw client) so the
 * backing client can be swapped without touching route/controller code, the
 * same boundary discipline as `AppDatabase`.
 */
export interface RedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  ping(): Promise<'ok' | 'down'>;
  /** Raw ioredis client for pub/sub and commands the facade does not wrap. */
  client(): Redis;
  disconnect(): Promise<void>;
}

class IoRedisCache implements RedisCache {
  private readonly redis: Redis;

  constructor(url: string) {
    // lazyConnect keeps construction non-blocking: the first command (or the
    // health probe) opens the connection, so an unreachable Redis never stops
    // the app from booting.
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // Without a listener ioredis would crash the process on a connection
    // 'error'; swallow it so an outage degrades the health check instead.
    this.redis.on('error', () => undefined);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async ping(): Promise<'ok' | 'down'> {
    try {
      return (await this.redis.ping()) === 'PONG' ? 'ok' : 'down';
    } catch {
      return 'down';
    }
  }

  client(): Redis {
    return this.redis;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

let cache: RedisCache | null = null;
let resolved = false;

/**
 * Lazily resolve the shared Redis cache. Returns `null` when `REDIS_URL` is
 * unset so the API boots and runs without Redis in local development — Redis is
 * an optional capability, never a hard startup dependency.
 */
export function getCache(env: NodeJS.ProcessEnv = process.env): RedisCache | null {
  if (!resolved) {
    const url = env.REDIS_URL;
    cache = url ? new IoRedisCache(url) : null;
    resolved = true;
  }
  return cache;
}

/** Close the client (if any) and reset the memoized state. Safe to call always. */
export async function disconnectCache(): Promise<void> {
  const current = cache;
  cache = null;
  resolved = false;
  if (current) await current.disconnect();
}

/**
 * Dependency probe for the `/healthz` report. Returns `null` when Redis is not
 * configured so it is omitted from the report rather than shown as down.
 */
export async function checkRedisHealth(): Promise<RedisHealth | null> {
  const client = getCache();
  if (!client) return null;

  const startedAt = performance.now();
  try {
    const status = await client.ping();
    return { status, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err: unknown) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : 'Redis health check failed',
    };
  }
}
