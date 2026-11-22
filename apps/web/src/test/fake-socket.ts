import { vi } from 'vitest';

// Minimal in-memory stand-in for a socket.io `Socket`, used to test the WS
// client + provider without a live gateway (R3 acceptance: "the full flow passes
// against the mock with no real gateway running"). Tests `vi.mock` the
// `socket.io-client` `io` factory to return one of these and drive frames via
// the `__emit*` helpers.

type Listener = (...args: unknown[]) => void;

export interface FakeSocket {
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  /**
   * Mirrors socket.io's `socket.timeout(ms)`: returns an emitter whose ack
   * callback is `(err, ack)`. If the underlying `emit` mock never invokes the
   * ack (the server threw / sent nothing), the timer fires `(Error)` after `ms`,
   * so callers using `.timeout().emit()` reject instead of hanging forever.
   */
  timeout: (ms: number) => { emit: (event: string, ...args: unknown[]) => FakeSocket };
  on: (event: string, cb: Listener) => FakeSocket;
  off: (event: string, cb?: Listener) => FakeSocket;
  removeAllListeners: () => FakeSocket;
  /** The Manager surface (`socket.io`) that carries reconnection lifecycle events. */
  io: {
    on: (event: string, cb: Listener) => void;
    off: (event: string, cb?: Listener) => void;
  };
  /** Fire a socket-level event (e.g. `connect`, `notification`). */
  __emit: (event: string, ...args: unknown[]) => void;
  /** Fire a Manager-level event (e.g. `reconnect_attempt`, `reconnect_failed`). */
  __emitManager: (event: string, ...args: unknown[]) => void;
}

export function createFakeSocket(): FakeSocket {
  const socketListeners = new Map<string, Set<Listener>>();
  const managerListeners = new Map<string, Set<Listener>>();

  const add = (map: Map<string, Set<Listener>>, event: string, cb: Listener) => {
    const set = map.get(event) ?? new Set<Listener>();
    set.add(cb);
    map.set(event, set);
  };
  const remove = (map: Map<string, Set<Listener>>, event: string, cb?: Listener) => {
    if (!cb) {
      map.delete(event);
      return;
    }
    map.get(event)?.delete(cb);
  };
  const fire = (map: Map<string, Set<Listener>>, event: string, args: unknown[]) => {
    for (const cb of [...(map.get(event) ?? [])]) {
      cb(...args);
    }
  };

  const socket: FakeSocket = {
    connected: false,
    connect: vi.fn(() => {
      socket.connected = true;
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
      return socket;
    }),
    emit: vi.fn(() => socket),
    timeout: (ms) => ({
      emit: (event, ...args) => {
        const ackCb = args[args.length - 1] as (err: Error | null, ack?: unknown) => void;
        const rest = args.slice(0, -1);
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const settle = (err: Error | null, ack?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ackCb(err, ack);
        };
        timer = setTimeout(() => settle(new Error('operation has timed out')), ms);
        // Delegate to the plain `emit` mock so a test can still drive the ack.
        // The mock invokes a single-arg ack (the server payload); forward it as
        // the `(null, ack)` shape socket.io's timeout wrapper produces.
        socket.emit(event, ...rest, (ack: unknown) => settle(null, ack));
        return socket;
      },
    }),
    on: (event, cb) => {
      add(socketListeners, event, cb);
      return socket;
    },
    off: (event, cb) => {
      remove(socketListeners, event, cb);
      return socket;
    },
    removeAllListeners: () => {
      socketListeners.clear();
      return socket;
    },
    io: {
      on: (event, cb) => add(managerListeners, event, cb),
      off: (event, cb) => remove(managerListeners, event, cb),
    },
    __emit: (event, ...args) => fire(socketListeners, event, args),
    __emitManager: (event, ...args) => fire(managerListeners, event, args),
  };
  return socket;
}
