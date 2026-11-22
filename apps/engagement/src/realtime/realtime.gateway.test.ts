import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createEvent, MIO_REALTIME_TYPES, type NotificationEnvelope } from '@ex-mio/contracts';
import { io as connect, type Socket } from 'socket.io-client';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';
import type { Principal, TicketRedeemer } from './ticket-redeemer';

/*
 * Realtime gateway properties (D-10, D-25), against a real socket.io-client and the in-process Nest
 * Fastify app. The redeemer is a fake with identity's contract: a ticket works ONCE, then it is refused.
 *
 * Mutations (each re-applied by hand, see the report):
 *  - gateway.ts authenticate(): skip the `typeof ticket` check          -> NO-TICKET (redeem is called)
 *  - gateway.ts middleware: `next()` whatever the redeemer answered     -> NO-TICKET, REPLAY
 *  - gateway.ts: `new Server({ connectionStateRecovery: {} })`          -> RECOVERY-OFF
 *  - rooms.ts roomName(): drop the tenant segment                       -> TENANT-ISOLATION
 *  - gateway.ts: take the room from `auth.room` instead of the principal -> NO-CLIENT-ROOM
 *  - gateway.ts: the default namespace left open                        -> DEFAULT-NS
 */

const T_A = '11111111-1111-4111-8111-111111111111';
const T_B = '22222222-2222-4222-8222-222222222222';
const P_1 = '33333333-3333-4333-8333-333333333333';
const P_2 = '44444444-4444-4444-8444-444444444444';

class FakeIdentity implements TicketRedeemer {
  readonly issued = new Map<string, Principal>();
  readonly used = new Set<string>();
  calls: string[] = [];
  down = false;
  private n = 0;
  ticketFor(tid: string, sub: string): string {
    const t = `ticket-${(this.n += 1)}`;
    this.issued.set(t, { sub, tid, roles: ['player'] });
    return t;
  }
  async redeem(ticket: string): Promise<Principal | null> {
    this.calls.push(ticket);
    if (this.down) throw new Error('identity unreachable');
    const p = this.issued.get(ticket);
    if (!p || this.used.has(ticket)) return null; // unknown, or REALTIME_TICKET_REPLAYED
    this.used.add(ticket);
    return p;
  }
}

interface World {
  app: NestFastifyApplication;
  identity: FakeIdentity;
  gateway: RealtimeGateway;
  url: string;
}

async function boot(): Promise<World> {
  const identity = new FakeIdentity();
  const mod = await Test.createTestingModule({
    imports: [RealtimeModule.register({ redeemer: identity })],
  }).compile();
  const app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, identity, gateway: app.get(RealtimeGateway), url: `http://127.0.0.1:${port}` };
}

const sockets: Socket[] = [];
const open = (url: string, auth?: Record<string, unknown>, extra = {}): Socket => {
  const s = connect(`${url}/rt`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...(auth ? { auth } : {}),
    ...extra,
  });
  sockets.push(s);
  return s;
};
const settle = (s: Socket): Promise<'connected' | 'refused'> =>
  new Promise((resolve) => {
    s.once('connect', () => resolve('connected'));
    s.once('connect_error', () => resolve('refused'));
  });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const collect = (s: Socket): NotificationEnvelope[] => {
  const got: NotificationEnvelope[] = [];
  s.on('notification', (f: NotificationEnvelope) => got.push(f));
  return got;
};

const spinEvent = (tenantId: string, playerId: string) =>
  createEvent({
    type: 'engagement.spin.completed',
    tenantId,
    payload: {
      spin_id: '55555555-5555-4555-8555-555555555555',
      player_id: playerId,
      reward_coins: 7,
      table_version: 1,
    },
  });

let w: World;
beforeEach(async () => {
  w = await boot();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await w.app.close();
});

describe('realtime gateway', () => {
  it('NO-TICKET: no ticket means no connection, and identity is never asked', async () => {
    for (const auth of [undefined, {}, { token: '' }, { token: 42 }]) {
      const s = open(w.url, auth as Record<string, unknown> | undefined);
      expect(await settle(s)).toBe('refused');
      expect(s.connected).toBe(false);
    }
    expect(w.identity.calls).toEqual([]);
  });

  it('REPLAY: a replayed ticket is refused, and so is an unknown one', async () => {
    const ticket = w.identity.ticketFor(T_A, P_1);
    const first = open(w.url, { token: ticket });
    expect(await settle(first)).toBe('connected');
    const second = open(w.url, { token: ticket });
    expect(await settle(second)).toBe('refused');
    expect(await settle(open(w.url, { token: 'forged' }))).toBe('refused');
  });

  it('IDENTITY-DOWN: if identity cannot be reached the socket is refused', async () => {
    w.identity.down = true;
    expect(await settle(open(w.url, { token: w.identity.ticketFor(T_A, P_1) }))).toBe('refused');
  });

  it('DEFAULT-NS: nothing is served on the default namespace', async () => {
    const s = connect(w.url, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    expect(await settle(s)).toBe('refused');
  });

  it('DELIVERED: an event reaches the connected player', async () => {
    const s = open(w.url, { token: w.identity.ticketFor(T_A, P_1) });
    const got = collect(s);
    await settle(s);
    await pause(50); // the server-side join follows the connect
    w.gateway.publish(spinEvent(T_A, P_1));
    await pause(150);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      type: MIO_REALTIME_TYPES.spinResult,
      payload: { reward_coins: 7, table_version: 1 },
    });
  });

  it('DELIVERED: balance change and redemption status reach the player too', async () => {
    const s = open(w.url, { token: w.identity.ticketFor(T_A, P_1) });
    const got = collect(s);
    await settle(s);
    await pause(50);
    const id = '66666666-6666-4666-8666-666666666666';
    w.gateway.publish(
      createEvent({
        type: 'payments.coins.captured',
        tenantId: T_A,
        payload: {
          transaction_id: id,
          player_id: P_1,
          wallet_id: id,
          reserve_id: id,
          amount: 5,
          available_after: 20,
          held_after: 0,
        },
      }),
    );
    w.gateway.publish(
      createEvent({
        type: 'engagement.redemption.status_changed',
        tenantId: T_A,
        payload: { redemption_id: id, player_id: P_1, from: null, to: 'REQUESTED', cause: 'x' },
      }),
    );
    await pause(150);
    expect(got.map((f) => f.type)).toEqual([
      MIO_REALTIME_TYPES.balanceChanged,
      MIO_REALTIME_TYPES.redemptionStatus,
    ]);
    expect(got[0]?.payload).toEqual({ reason: 'captured', amount: 5, available: 20, held: 0 });
    expect(JSON.stringify(got)).not.toContain('wallet_id');
  });

  it('PLAYER-ISOLATION: player A never receives player B events', async () => {
    const a = open(w.url, { token: w.identity.ticketFor(T_A, P_1) });
    const b = open(w.url, { token: w.identity.ticketFor(T_A, P_2) });
    const gotA = collect(a);
    const gotB = collect(b);
    await Promise.all([settle(a), settle(b)]);
    await pause(50);
    w.gateway.publish(spinEvent(T_A, P_2));
    await pause(150);
    expect(gotB).toHaveLength(1);
    expect(gotA).toEqual([]);
  });

  it('TENANT-ISOLATION: tenant A player never receives tenant B events, even with the same player id', async () => {
    const a = open(w.url, { token: w.identity.ticketFor(T_A, P_1) });
    const b = open(w.url, { token: w.identity.ticketFor(T_B, P_1) });
    const gotA = collect(a);
    const gotB = collect(b);
    await Promise.all([settle(a), settle(b)]);
    await pause(50);
    w.gateway.publish(spinEvent(T_B, P_1));
    await pause(150);
    expect(gotB).toHaveLength(1);
    expect(gotA).toEqual([]);
  });

  it('NO-CLIENT-ROOM: a client cannot choose a room, by handshake or by event', async () => {
    const victim = open(w.url, { token: w.identity.ticketFor(T_B, P_2) });
    const gotVictim = collect(victim);
    const attacker = open(
      w.url,
      { token: w.identity.ticketFor(T_A, P_1), room: `t:${T_B}:player:${P_2}` },
      { query: { room: `t:${T_B}:player:${P_2}` } },
    );
    const gotAttacker = collect(attacker);
    await Promise.all([settle(victim), settle(attacker)]);
    for (const ev of ['subscribe', 'join', 'room']) {
      attacker.emit(ev, { room: `t:${T_B}:player:${P_2}` }, `t:${T_B}:player:${P_2}`);
    }
    await pause(100);
    w.gateway.publish(spinEvent(T_B, P_2));
    await pause(150);
    expect(gotVictim).toHaveLength(1);
    expect(gotAttacker).toEqual([]);
  });

  it('RECOVERY-OFF: a reconnect after a dropped transport needs a fresh ticket', async () => {
    const ticket = w.identity.ticketFor(T_A, P_1);
    const s = open(
      w.url,
      { token: ticket },
      { reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 50 },
    );
    const got = collect(s);
    await settle(s);
    await pause(50);
    // one delivered event gives the client a recovery offset (what a recovery-enabled server needs)
    w.gateway.publish(spinEvent(T_A, P_1));
    await pause(100);
    expect(got).toHaveLength(1);
    got.length = 0;
    // the client keeps offering the SAME (used) ticket on reconnect, as a stale or hostile client would
    const refused = new Promise<void>((resolve) => s.on('connect_error', () => resolve()));
    s.io.engine.close(); // abnormal drop: the case connectionStateRecovery would restore
    await refused;
    expect(s.connected).toBe(false);
    expect(w.identity.calls.filter((t) => t === ticket).length).toBeGreaterThanOrEqual(2);
    w.gateway.publish(spinEvent(T_A, P_1));
    await pause(150);
    expect(got).toEqual([]);
    // with a fresh ticket the player is back
    s.io.opts.reconnection = false;
    s.auth = { token: w.identity.ticketFor(T_A, P_1) };
    const back = settle(s);
    s.connect();
    expect(await back).toBe('connected');
  });
});

/*
 * COMMIT-ONLY: pushes leave after the handler's transaction commits.
 * Mutation: `queue()` in realtime.gateway.ts calls `this.publish(event)` inline -> both tests red.
 * The fake runner replays what TypeORM does: the connection's subscribers get afterTransactionCommit
 * or afterTransactionRollback with the transaction's query runner. As in TypeORM, the runner is no
 * longer in a transaction when those events fire (a nested savepoint release keeps it active).
 */
type Sub = {
  afterTransactionCommit?: (e: unknown) => void;
  afterTransactionRollback?: (e: unknown) => void;
};
function txRunner() {
  const connection = { subscribers: [] as Sub[] };
  return async (fn: (manager: never) => Promise<void>): Promise<void> => {
    const queryRunner = { isTransactionActive: true, connection };
    const manager = { queryRunner, connection } as never;
    try {
      await fn(manager);
    } catch (err) {
      queryRunner.isTransactionActive = false;
      connection.subscribers.forEach((s) => s.afterTransactionRollback?.({ queryRunner }));
      throw err;
    }
    queryRunner.isTransactionActive = false;
    connection.subscribers.forEach((s) => s.afterTransactionCommit?.({ queryRunner }));
  };
}

describe('realtime push after commit', () => {
  it('COMMIT-ONLY: a handler that throws after queueing an emit delivers no push', async () => {
    const run = txRunner();
    const s = open(w.url, { token: w.identity.ticketFor(T_A, P_1) });
    const got = collect(s);
    await settle(s);
    await pause(50);
    await expect(
      run(async (tx) => {
        w.gateway.queue(tx, spinEvent(T_A, P_1));
        await pause(100); // a push sent inline would arrive while the transaction is still open
        expect(got).toEqual([]);
        throw new Error('handler failed after queueing');
      }),
    ).rejects.toThrow('handler failed');
    await pause(150);
    expect(got).toEqual([]);
  });

  it('COMMIT-ONLY: a committed handler pushes exactly once, and only after the commit', async () => {
    const run = txRunner();
    const s = open(w.url, { token: w.identity.ticketFor(T_A, P_1) });
    const got = collect(s);
    await settle(s);
    await pause(50);
    await run(async (tx) => {
      w.gateway.queue(tx, spinEvent(T_A, P_1));
      await pause(100);
      expect(got).toEqual([]);
    });
    await pause(150);
    expect(got).toHaveLength(1);
  });
});
