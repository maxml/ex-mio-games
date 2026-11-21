import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { parseCorsOrigins } from '../config/cors';
import { reportError } from '../error-reporter';

/** Just the pub/sub surface the adapter needs from R1's raw Redis client. */
export interface RealtimeRedisClient {
  duplicate(): unknown;
}

/** A Redis client the adapter owns and must clean up (the duplicated subscriber). */
interface ClosableRedisClient {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  quit(): Promise<unknown>;
}

export interface RealtimeAdapterOptions {
  /** Reuses the API's `CORS_ORIGIN` allow-list — never `*` in production. */
  corsOrigin: string;
  /**
   * Raw Redis client from the R1 `RedisCache` facade for cross-instance
   * fan-out. `null` runs single-instance (no backplane) — the graceful
   * degradation that mirrors R1's optional pattern.
   */
  redisClient: RealtimeRedisClient | null;
}

// Kept consistent with the client's reconnect backoff (R3) so heartbeats and
// reconnects don't fight. WebSocket-only transport avoids LB sticky-session
// requirements for the polling handshake across instances.
const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 20_000;

/**
 * socket.io adapter that attaches to the Nest app's underlying (Fastify) HTTP
 * server and applies the production settings from the ADR: a config-driven CORS
 * allow-list, WebSocket-only transport, a tuned heartbeat, and — when Redis is
 * configured — the `@socket.io/redis-adapter` backplane.
 */
export class RealtimeIoAdapter extends IoAdapter {
  // Redis clients this adapter created (the duplicated subscriber). Held so they
  // can be quit on shutdown — the shared publisher client is owned by the cache
  // facade and closed by `disconnectCache()`, so it is NOT tracked here.
  private readonly subscriberClients: ClosableRedisClient[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly options: RealtimeAdapterOptions,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // Shared parsing (see config/cors) so the WS allow-list never drifts from the
    // HTTP one: a lone `*` reflects any origin (dev only — the prod config guard
    // rejects any wildcard), otherwise the explicit allow-list.
    const parsedOrigin = parseCorsOrigins(this.options.corsOrigin);
    const origin = parsedOrigin === '*' ? true : parsedOrigin;

    const server = super.createIOServer(port, {
      ...options,
      cors: { origin, credentials: true },
      transports: ['websocket'],
      pingInterval: PING_INTERVAL_MS,
      pingTimeout: PING_TIMEOUT_MS,
    }) as Server;

    const client = this.options.redisClient;
    if (client) {
      // Reuse R1's connection for publishes; the adapter requires a dedicated
      // subscriber connection, hence the single `duplicate()`.
      const pub = client as Parameters<typeof createAdapter>[0];
      const sub = client.duplicate() as Parameters<typeof createAdapter>[1];
      // ioredis raises an *unhandled* 'error' (crashing the process) on a
      // backplane outage unless a listener is attached. The shared publisher
      // client already has one (the cache facade); the duplicated subscriber
      // does not, so attach one here — log via the ErrorReporter facade and
      // swallow, so a Redis blip degrades fan-out instead of taking the API down.
      const closable = sub as unknown as ClosableRedisClient;
      closable.on('error', (err) => reportError(err, { scope: 'realtime:redis-adapter' }));
      this.subscriberClients.push(closable);
      server.adapter(createAdapter(pub, sub));
    }

    return server;
  }

  /**
   * Quit the Redis clients this adapter created (the duplicated subscriber).
   * Null-safe: a no-op when running single-instance (no Redis). Call from the
   * shutdown path alongside `disconnectCache()`.
   */
  async closeRedisClients(): Promise<void> {
    const clients = this.subscriberClients.splice(0);
    await Promise.all(clients.map((client) => client.quit().catch(() => undefined)));
  }
}
