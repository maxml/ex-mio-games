/** Exponential backoff with a cap: attempt 1 waits `baseMs`, attempt 2 `2 * baseMs`, ... up to `maxMs`. */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export function backoffMs(attempt: number, { baseMs, maxMs }: BackoffOptions): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A handler throws this (or a subclass) to say "retry me later" without a driver error code. */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/** SQLSTATE values that mean "try again": serialization, deadlock, lock/pool pressure, restarts. */
const TRANSIENT_SQLSTATE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const TRANSIENT_MESSAGE =
  /timeout exceeded|timed out|connection terminated|connection error|too many clients|server closed the connection/i;

function codesOf(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; driverError?: unknown; cause?: unknown };
    if (typeof e.code === 'string') codes.push(e.code);
    current = e.driverError ?? e.cause;
  }
  return codes;
}

/**
 * Is this failure worth retrying? Database connection loss, timeouts, deadlocks
 * and serialization failures are. Everything else (validation, unknown type, a
 * constraint violation, a bug) is permanent: retrying cannot change the outcome.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  for (const code of codesOf(err)) {
    if (TRANSIENT_SQLSTATE.has(code) || TRANSIENT_NODE_CODES.has(code)) return true;
    if (code.startsWith('08')) return true; // connection_exception class
  }
  return err instanceof Error && TRANSIENT_MESSAGE.test(err.message);
}
