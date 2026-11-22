import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { createFakeSocket, type FakeSocket } from '../../../../test/fake-socket';
import { reconnectionOptions } from './backoff';
import {
  disconnectWsClient,
  emitPing,
  emitSubscribe,
  getWsClient,
  onNotification,
  WS_ACK_TIMEOUT_MS,
} from './client';

// Mock the transport so nothing touches the network (R3: passes with no gateway).
vi.mock('socket.io-client', () => ({ io: vi.fn() }));
const mockedIo = vi.mocked(io);

type AuthFn = (cb: (data: { token: string }) => void) => void;

let fake: FakeSocket;

beforeEach(() => {
  fake = createFakeSocket();
  mockedIo.mockReturnValue(fake as unknown as ReturnType<typeof io>);
});

afterEach(() => {
  // Reset the module-level singleton between tests.
  disconnectWsClient();
});

describe('getWsClient', () => {
  it('connects to the notifications namespace with the websocket transport + backoff', () => {
    getWsClient({ getToken: () => 'seed' });

    expect(mockedIo).toHaveBeenCalledTimes(1);
    const [url, opts] = mockedIo.mock.calls[0] as [string, Record<string, unknown>];
    // The vitest env sets NEXT_PUBLIC_API_URL=http://localhost:4000; the WS origin
    // is derived from it with the scheme swapped http -> ws.
    expect(url).toBe('ws://localhost:4000/rt');
    expect(opts).toMatchObject({
      transports: ['websocket'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelayMax: reconnectionOptions.reconnectionDelayMax,
      reconnectionAttempts: reconnectionOptions.reconnectionAttempts,
      randomizationFactor: reconnectionOptions.randomizationFactor,
    });
  });

  it('supplies the handshake token via socket.io auth (re-evaluated per connect)', async () => {
    getWsClient({ getToken: () => 'seed-token' });

    const opts = mockedIo.mock.calls[0][1] as { auth: AuthFn };
    const data = await new Promise<{ token: string }>((resolve) => opts.auth(resolve));
    expect(data).toEqual({ token: 'seed-token' });
  });

  it('falls back to the SAME ORIGIN when NEXT_PUBLIC_API_URL is unset (realtime ON, not off)', () => {
    const previous = process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    try {
      getWsClient();

      const [url] = mockedIo.mock.calls[0] as [string, Record<string, unknown>];
      // No baked domain: the origin is derived from the current page
      // (`ws://` on an http page) plus the notifications namespace.
      expect(url).toBe(`ws://${window.location.host}/rt`);
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_API_URL = previous;
    }
  });

  it('reuses a single shared socket instance', () => {
    const first = getWsClient();
    const second = getWsClient();

    expect(first).toBe(second);
    expect(mockedIo).toHaveBeenCalledTimes(1);
  });
});

describe('onNotification', () => {
  const valid = { id: 'n1', type: 'users.created', payload: { id: 'u1' }, ts: 1 };

  it('dispatches a Zod-valid notification and unsubscribes cleanly', () => {
    const socket = getWsClient();
    const handler = vi.fn();
    const off = onNotification(socket, handler);

    fake.__emit('notification', valid);
    expect(handler).toHaveBeenCalledWith(valid);

    off();
    handler.mockClear();
    fake.__emit('notification', valid);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops a frame that fails its Zod schema', () => {
    const socket = getWsClient();
    const handler = vi.fn();
    onNotification(socket, handler);

    fake.__emit('notification', { id: 'n2' }); // missing type/ts
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('emitPing', () => {
  it('emits ping and resolves the validated pong ack', async () => {
    const socket = getWsClient();
    fake.emit.mockImplementation((event: string, _payload: unknown, ack: (a: unknown) => void) => {
      if (event === 'ping') {
        ack({ event: 'pong', at: 7, serverTime: 123 });
      }
      return socket;
    });

    await expect(emitPing(socket, { at: 7 })).resolves.toEqual({
      event: 'pong',
      at: 7,
      serverTime: 123,
    });
  });

  it('rejects an ack that fails its Zod schema', async () => {
    const socket = getWsClient();
    fake.emit.mockImplementation((event: string, _payload: unknown, ack: (a: unknown) => void) => {
      ack({ event: 'nope' });
      return socket;
    });

    await expect(emitPing(socket)).rejects.toThrow(/invalid pong ack/);
  });
});

describe('emitSubscribe', () => {
  it('resolves the validated subscribe ack', async () => {
    const socket = getWsClient();
    fake.emit.mockImplementation((event: string, _payload: unknown, ack: (a: unknown) => void) => {
      if (event === 'subscribe') ack({ ok: true, room: 'users' });
      return socket;
    });

    await expect(emitSubscribe(socket, { room: 'users' })).resolves.toEqual({
      ok: true,
      room: 'users',
    });
  });

  // A gateway WsException (forbidden room / rate limit / unauth / validation)
  // sends no ack. Without the timeout the promise would hang forever; with it,
  // the emit must reject once the ack window elapses. (#4)
  it('rejects (times out) when the server never acks, instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const socket = getWsClient();
      // Server threw: the event is received but no ack is ever invoked.
      fake.emit.mockImplementation(() => socket);

      const pending = emitSubscribe(socket, { room: 'forbidden' });
      const assertion = expect(pending).rejects.toThrow(/subscribe timed out/);
      await vi.advanceTimersByTimeAsync(WS_ACK_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
