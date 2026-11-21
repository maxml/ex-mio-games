import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import {
  type NotificationEnvelope,
  PingInput,
  type PongAck,
  REALTIME_EVENTS,
  REALTIME_NAMESPACE,
  SubscribeInput,
  type SubscribeAck,
} from '@ex-mio/shared-types';
import { getBearerToken } from '@ex-mio/auth';
import { consumeToken, type RateLimitOptions } from './rate-limit';
import { REALTIME_AUTH, type RealtimeAuthService } from './tokens';

// Per-socket allowance for each inbound event (token bucket). Tuned for an
// example gateway: a 20-event burst, replenished at 10/s.
const EVENT_RATE_LIMIT: RateLimitOptions = { capacity: 20, refillPerSecond: 10 };

/**
 * Example socket.io gateway on the `notifications` namespace. Connections are
 * authenticated at handshake time through the wired `AuthService`; unauthenticated
 * sockets are disconnected before any event is accepted. Inbound payloads are
 * Zod-validated (same discipline as the HTTP body parsing in `server.ts`).
 *
 * CORS origin, `transports: ['websocket']`, the Redis adapter, and the
 * heartbeat are configured server-wide by `RealtimeIoAdapter`, not here.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class NotificationsGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  constructor(@Inject(REALTIME_AUTH) private readonly auth: RealtimeAuthService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = extractToken(client);
    const user = token ? await this.auth.verifyToken(token) : null;

    if (!user) {
      // Reject before the socket can emit anything.
      client.disconnect(true);
      return;
    }

    client.data.user = user;
    // A per-user room lets the app target a single principal across instances.
    void client.join(userRoom(user.id));
  }

  @SubscribeMessage(REALTIME_EVENTS.ping)
  handlePing(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): PongAck {
    this.assertAuthenticated(client);
    this.assertWithinRateLimit(client, REALTIME_EVENTS.ping);
    const input = parsePayload(PingInput, body);
    return { event: REALTIME_EVENTS.pong, at: input.at ?? null, serverTime: Date.now() };
  }

  @SubscribeMessage(REALTIME_EVENTS.subscribe)
  handleSubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): SubscribeAck {
    this.assertAuthenticated(client);
    this.assertWithinRateLimit(client, REALTIME_EVENTS.subscribe);
    const input = parsePayload(SubscribeInput, body);
    // Authorize the room: a client may only (re)join its OWN per-user room, never
    // `user:<other-id>` or an arbitrary domain room. Shared/domain rooms (e.g.
    // `org:<id>`, `booking:<id>`) require app-level authorization — this is the
    // seam to extend, e.g. via an injected room authorizer that checks the
    // caller's grants before `client.join`.
    if (input.room !== userRoom(client.data.user.id)) {
      throw new WsException('forbidden room');
    }
    void client.join(input.room);
    return { ok: true, room: input.room };
  }

  /**
   * Fan a notification to a room. Goes through the socket.io server, so with the
   * Redis adapter it reaches sockets held by other instances — the seam that
   * lets this gateway later extract to a standalone `apps/realtime` service.
   */
  emitNotification(room: string, notification: NotificationEnvelope): void {
    this.server.to(room).emit(REALTIME_EVENTS.notification, notification);
  }

  private assertAuthenticated(client: Socket): void {
    if (!client.data?.user) {
      throw new WsException('unauthorized');
    }
  }

  private assertWithinRateLimit(client: Socket, event: string): void {
    if (!consumeToken(client, event, EVENT_RATE_LIMIT)) {
      throw new WsException('rate limit exceeded');
    }
  }
}

function extractToken(client: Socket): string | null {
  // Browser WebSocket handshakes cannot set headers, so socket.io clients pass
  // the token via the `auth` option; header-capable clients fall back to the
  // Authorization bearer. The token shape stays provider-defined.
  const handshakeAuth = client.handshake.auth as { token?: unknown };
  if (typeof handshakeAuth?.token === 'string' && handshakeAuth.token.length > 0) {
    return handshakeAuth.token;
  }
  return getBearerToken(client.handshake.headers.authorization);
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

function parsePayload<T>(schema: z.ZodType<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      throw new WsException({ message: 'validation failed', issues: err.issues });
    }
    throw err;
  }
}
