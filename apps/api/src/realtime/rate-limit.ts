// Per-socket, per-event token bucket. Caps an abusive client without a shared
// store: the buckets live on `socket.data`, so they are isolated per connection
// and garbage-collected when the socket disconnects.

export interface RateLimitOptions {
  /** Burst size — tokens available when idle. */
  capacity: number;
  /** Steady-state allowance; tokens regained per second. */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

type BucketStore = Record<string, Bucket>;

/** A socket-like with a mutable `data` bag — the real socket.io `Socket.data`. */
export interface RateLimitedSocket {
  data: Record<string, unknown>;
}

/**
 * Try to spend one token for `event` on this socket. Returns `false` (deny)
 * when the bucket is empty. `now` is injectable for deterministic tests.
 */
export function consumeToken(
  socket: RateLimitedSocket,
  event: string,
  options: RateLimitOptions,
  now: number = Date.now(),
): boolean {
  let store = socket.data.rateBuckets as BucketStore | undefined;
  if (!store) {
    store = {};
    socket.data.rateBuckets = store;
  }

  const bucket = store[event] ?? { tokens: options.capacity, updatedAt: now };
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  const refilled = Math.min(
    options.capacity,
    bucket.tokens + elapsedSeconds * options.refillPerSecond,
  );

  if (refilled < 1) {
    store[event] = { tokens: refilled, updatedAt: now };
    return false;
  }

  store[event] = { tokens: refilled - 1, updatedAt: now };
  return true;
}
