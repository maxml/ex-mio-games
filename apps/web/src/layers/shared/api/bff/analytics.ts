// Product analytics of the web BFF (D-19). The BFF is the one place that sees a widget open before the
// player has launched, so `widget_opened` is written here. The line is built and validated by the same
// `buildProductEvent` as every service's (packages/contracts), and written to stdout as one JSON line,
// where the log collector picks it up. No pino here: the Next server bundle stays small.
import { buildProductEvent, type ProductEventInput } from '../../types';

export type ProductEventSink = (line: Record<string, unknown>) => void;

/** One JSON line on stdout, the way every service writes its product events. */
export const stdoutProductEvents: ProductEventSink = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/**
 * Validate and write one event. Like the services' `emitProductEvent`, a bad event is dropped with
 * a warn line and never fails the request.
 */
export function emitWebEvent(
  sink: ProductEventSink,
  input: ProductEventInput,
  env: Record<string, string | undefined> = process.env,
): void {
  const base = {
    ts: new Date().toISOString(),
    service: 'web',
    env: env.NODE_ENV ?? 'development',
    version: env.APP_VERSION ?? '0.0.1',
  };
  try {
    const payload = buildProductEvent(input);
    // A closed envelope: no `msg`, `pid`, `hostname` or `time` (Varta's collector drops them).
    sink({ ...base, level: 'info', ...payload });
  } catch (err) {
    sink({
      ...base,
      level: 'warn',
      msg: 'product_event_dropped',
      event: input.event,
      err: String(err).slice(0, 300),
    });
  }
}

export const ANON_COOKIE = 'mio_anon';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The anonymous id of a visitor: the cookie when it is a UUID we wrote, else a fresh one. */
export function anonIdFrom(cookieValue: string | undefined): { id: string; isNew: boolean } {
  if (cookieValue && UUID.test(cookieValue)) return { id: cookieValue, isNew: false };
  return { id: globalThis.crypto.randomUUID(), isNew: true };
}

/** Session cookie (no Max-Age): the id lives as long as the browser session, nothing longer. */
export const anonCookie = (id: string, secure: boolean): string =>
  `${ANON_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

/**
 * The tenant a launch token claims, from its key id (`key_<tenant as 32 hex>_<random>`). It is a
 * routing hint read WITHOUT verification, like `peekClaims`: before the exchange nobody can say more.
 * Only an anonymous event uses it; once launched, the session's verified tenant is used instead.
 */
export function tenantHintOfLaunchToken(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as {
      kid?: unknown;
    };
    const m = typeof header.kid === 'string' ? /^key_([0-9a-f]{32})_/.exec(header.kid) : null;
    if (!m) return undefined;
    const h = m[1]!;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return undefined;
  }
}
