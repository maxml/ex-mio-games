// Server-side session (D-10). The browser holds one opaque, HttpOnly cookie. The access tokens, and the
// acting tokens a platform admin gets from `POST /v1/auth/acting`, live ONLY here and are never put in a
// response body, so browser JavaScript can never read them.
//
// The store is in-memory: one web instance, sessions die with the process. That is enough for the
// submission; a second instance needs a shared store behind the same `SessionStore` interface (listed
// in docs/submission/known-gaps.md).

export type ServiceAudience = 'identity' | 'engagement' | 'payments';

export interface HeldToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface Session {
  id: string;
  kind: 'player' | 'operator';
  tenantId: string;
  userId: string;
  roles: string[];
  tokens: Partial<Record<ServiceAudience, HeldToken>>;
  /** A platform admin acting for a tenant (L1 `POST /v1/auth/acting`): one token per audience. */
  acting: { tenantId: string; tokens: Partial<Record<ServiceAudience, HeldToken>> } | null;
  /** The payment attempt the console is following. */
  attemptId: string | null;
  /** The last spin this session made, so the widget can hold the result back until the wheel stops. */
  lastSpin: { id: string; index: number; coins: number } | null;
  /** Sandbox demo switch: the last value the player set (the sandbox casino holds the real fault). */
  casinoDown: boolean;
}

export interface SessionStore {
  create(data: Omit<Session, 'id'>): Session;
  get(id: string | undefined): Session | null;
  destroy(id: string | undefined): void;
}

export const SESSION_COOKIE = 'mio_sid';
const MAX_SESSIONS = 10_000;

export function createMemorySessionStore(
  newId: () => string = () => globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID(),
): SessionStore {
  const map = new Map<string, Session>();
  return {
    create(data) {
      // Bounded: the oldest session goes first, so an unauthenticated flood cannot grow the process.
      if (map.size >= MAX_SESSIONS) map.delete(map.keys().next().value as string);
      const session: Session = { ...data, id: newId() };
      map.set(session.id, session);
      return session;
    },
    get: (id) => (id ? (map.get(id) ?? null) : null),
    destroy: (id) => {
      if (id) map.delete(id);
    },
  };
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export const clearedSessionCookie = (secure: boolean): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/**
 * The token to send to `audience`. An acting token wins while it is valid (the admin sees the tenant's
 * screens), otherwise the session's own. A token inside its last 5 s counts as expired.
 */
export function bearerFor(
  session: Session,
  audience: ServiceAudience,
  now: number = Date.now(),
): string | null {
  const usable = (t: HeldToken | undefined) => (t && t.expiresAt - 5_000 > now ? t.token : null);
  if (session.acting) {
    const acting = usable(session.acting.tokens[audience]);
    if (acting) return acting;
    // An expired acting grant is dropped: the admin must start a new, audited one.
    session.acting = null;
  }
  return usable(session.tokens[audience]);
}

/** Claims of our own JWT, read WITHOUT verification: only to label the session. The services verify. */
export function peekClaims(token: string): { sub: string; tid: string; roles: string[] } {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub?: unknown; tid?: unknown; roles?: unknown };
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      tid: typeof payload.tid === 'string' ? payload.tid : '',
      roles: Array.isArray(payload.roles) ? payload.roles.filter((r) => typeof r === 'string') : [],
    };
  } catch {
    return { sub: '', tid: '', roles: [] };
  }
}
