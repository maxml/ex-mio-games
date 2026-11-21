import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { MIO_REALTIME_NAMESPACE, REALTIME_EVENTS, type EventEnvelope } from '@ex-mio/contracts';
import { Server, type Namespace } from 'socket.io';
import type { EntityManager } from 'typeorm';
import { PostCommitPushes } from './post-commit-pushes';
import { toPush } from './realtime.events';
import { roomName, roomOf } from './rooms';
import type { TicketRedeemer } from './ticket-redeemer';

export const TICKET_REDEEMER = Symbol('TICKET_REDEEMER');
export const REALTIME_OPTIONS = Symbol('REALTIME_OPTIONS');

export interface RealtimeOptions {
  /** Browser origins allowed to open a socket cross-origin. Empty: same-origin only. */
  allowedOrigins?: readonly string[];
}

/**
 * The MIO realtime gateway (D-10, D-25), a Socket.IO server on the Nest Fastify adapter's HTTP server.
 *
 * - `connectionStateRecovery` is OFF: in Socket.IO 4.8 recovery restores rooms and replays packets
 *   BEFORE middleware runs, so it would skip the ticket. A reconnect needs a fresh ticket.
 * - Namespace `/rt`. The handshake carries one thing, `auth.token`: the one-time ticket. The
 *   middleware redeems it through identity; a missing, refused or replayed ticket (or an unreachable
 *   identity) ends the handshake with no socket and no join.
 * - The room is derived from the redeemed principal only (`rooms.ts`). No client event can join or
 *   leave a room: the gateway registers no client-to-server handler at all.
 * - Delivery is at most once: an event is emitted to the sockets in the room at that moment and is
 *   never buffered or replayed. The client resyncs over REST after a reconnect.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('RealtimeGateway');
  private io: Server | undefined;
  private ns: Namespace | undefined;
  private readonly postCommit = new PostCommitPushes((e) => this.publish(e));

  /**
   * What the bus handler calls: the push waits for the handler's transaction to commit and is
   * dropped if it rolls back.
   */
  queue(tx: EntityManager, event: EventEnvelope): void {
    this.postCommit.queue(tx, event);
  }

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(TICKET_REDEEMER) private readonly redeemer: TicketRedeemer,
    @Inject(REALTIME_OPTIONS) private readonly options: RealtimeOptions,
  ) {}

  onApplicationBootstrap(): void {
    const origins = this.options.allowedOrigins ?? [];
    const io = new Server(this.adapterHost.httpAdapter.getHttpServer(), {
      serveClient: false,
      // explicit: see the class comment. Never switch this on.
      connectionStateRecovery: undefined,
      // no `cors` option: socket.io sends no CORS headers, so only same-origin browsers connect
      ...(origins.length > 0 ? { cors: { origin: [...origins], credentials: false } } : {}),
    });
    // Nothing is served on the default namespace.
    io.use((_socket, next) => next(new Error('namespace_not_served')));
    const ns = io.of(`/${MIO_REALTIME_NAMESPACE}`);
    ns.use((socket, next) => {
      void this.authenticate(socket.handshake.auth, socket).then(
        () => next(),
        () => next(new Error('unauthorized')),
      );
    });
    ns.on('connection', (socket) => {
      const room = socket.data.room as string | undefined;
      if (!room) {
        socket.disconnect(true); // unreachable behind the middleware; fail closed
        return;
      }
      void socket.join(room);
    });
    this.io = io;
    this.ns = ns;
  }

  private async authenticate(
    auth: unknown,
    socket: { data: Record<string, unknown> },
  ): Promise<void> {
    const ticket = (auth as { token?: unknown } | undefined)?.token;
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4096) {
      throw new Error('no ticket');
    }
    const principal = await this.redeemer.redeem(ticket);
    if (!principal) throw new Error('ticket refused');
    socket.data.room = roomOf(principal);
  }

  /** Pushes one bus event to its player's room, if it is one the player hears about. Never throws. */
  publish(event: EventEnvelope): void {
    const push = toPush(event);
    if (!push || !this.ns) return;
    try {
      this.ns
        .to(roomName(push.tenantId, 'player', push.playerId))
        .emit(REALTIME_EVENTS.notification, push.frame);
    } catch (err) {
      this.log.warn(`realtime push failed: ${(err as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const io = this.io;
    this.io = undefined;
    this.ns = undefined;
    if (io) await io.close();
  }
}
