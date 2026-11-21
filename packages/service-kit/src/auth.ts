import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ACCESS_TTL_MAX_SECONDS,
  AccessTokenClaims,
  JWKS_CACHE_TTL_SECONDS,
  JWKS_REFETCH_MIN_INTERVAL_SECONDS,
  SERVICE_TOKEN_TTL_MAX_SECONDS,
  ServiceTokenClaims,
} from '@ex-mio/contracts';

/**
 * The token verifier every service uses (spec section 1.4). It trusts only RS256 tokens signed by
 * a key of identity's JWKS, chosen by `kid`; it checks audience, expiry (with the skew leeway),
 * the TTL cap and the claim schema. Nothing here reads a header, a query or a body.
 */

export type TokenRejectedCode = 'TOKEN_INVALID' | 'TOKEN_EXPIRED';

export class TokenRejectedError extends Error {
  constructor(
    readonly code: TokenRejectedCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

export interface Jwks {
  keys: Array<Record<string, unknown>>;
}
export type JwksFetcher = () => Promise<Jwks>;

export interface VerifierOptions {
  audience: string;
  jwks: JwksFetcher;
  /** Unix seconds; injected so tests control the clock. */
  nowSeconds?: () => number;
  /** Share one key cache between several verifiers of one service (internal). */
  cache?: JwksCache;
}

const defaultNow = (): number => Math.floor(Date.now() / 1000);

/**
 * One JWKS cache: the key set is kept JWKS_CACHE_TTL_SECONDS; a `kid` that is not in it triggers
 * one refetch, at most once per JWKS_REFETCH_MIN_INTERVAL_SECONDS; a failed fetch fails closed
 * (no stale-if-error). Concurrent lookups share one in-flight fetch.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt: number | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly fetcher: JwksFetcher,
    private readonly now: () => number = defaultNow,
  ) {}

  async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = this.now();
    if (this.fetchedAt === undefined || now - this.fetchedAt >= JWKS_CACHE_TTL_SECONDS) {
      await this.refresh(now);
    } else if (!this.keys.has(kid) && now - this.fetchedAt >= JWKS_REFETCH_MIN_INTERVAL_SECONDS) {
      await this.refresh(now);
    }
    return this.keys.get(kid);
  }

  private refresh(now: number): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const set = await this.fetcher();
        const next = new Map<string, KeyObject>();
        for (const jwk of set.keys ?? []) {
          if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
          } catch {
            /* a malformed key is skipped, never trusted */
          }
        }
        this.keys = next;
        this.fetchedAt = now;
      } catch {
        // fail closed: drop the stale key set so a later lookup cannot use it
        this.keys = new Map();
        this.fetchedAt = undefined;
        throw new TokenRejectedError('TOKEN_INVALID', 'key set unavailable');
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

interface Decoded {
  payload: Record<string, unknown>;
}

async function verifySignedToken(token: string, cache: JwksCache): Promise<Decoded> {
  const bad = (m: string) => new TokenRejectedError('TOKEN_INVALID', m);
  if (typeof token !== 'string') throw bad('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw bad('malformed');
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw bad('malformed');
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    throw bad('malformed');
  }
  // Allow-list: RS256 only. `none`, HS* (incl. the public key used as an HMAC secret) are refused.
  if (header.alg !== 'RS256') throw bad('algorithm not allowed');
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw bad('kid required');
  const key = await cache.keyFor(header.kid);
  if (!key) throw bad('unknown key');
  let ok = false;
  try {
    ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw bad('signature');
  return { payload };
}

function checkTimes(
  payload: Record<string, unknown>,
  now: number,
  maxTtl: number,
  claims: { iat: number; exp: number },
): void {
  const skew = ACCESS_TOKEN_CLOCK_SKEW_SECONDS;
  if (claims.exp - claims.iat > maxTtl) throw new TokenRejectedError('TOKEN_INVALID', 'ttl');
  if (claims.iat > now + skew) throw new TokenRejectedError('TOKEN_INVALID', 'iat');
  const nbf = payload.nbf;
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) {
      throw new TokenRejectedError('TOKEN_INVALID', 'nbf');
    }
    if (nbf > now + skew) throw new TokenRejectedError('TOKEN_INVALID', 'nbf');
  }
  if (now > claims.exp + skew) throw new TokenRejectedError('TOKEN_EXPIRED', 'expired');
}

/** `(token) => claims` for user (access) tokens of one audience. */
export function createTokenVerifier(
  options: VerifierOptions,
): (token: string) => Promise<AccessTokenClaims> {
  const now = options.nowSeconds ?? defaultNow;
  const cache = options.cache ?? new JwksCache(options.jwks, now);
  return async (token) => {
    const { payload } = await verifySignedToken(token, cache);
    const parsed = AccessTokenClaims.safeParse(payload);
    if (!parsed.success) throw new TokenRejectedError('TOKEN_INVALID', 'claims');
    const claims = parsed.data;
    if (claims.aud !== options.audience) throw new TokenRejectedError('TOKEN_INVALID', 'audience');
    // `act` exists only on a platform_admin token (a forged acting claim on an operator token).
    if (claims.act && !claims.roles.includes('platform_admin')) {
      throw new TokenRejectedError('TOKEN_INVALID', 'act without platform_admin');
    }
    checkTimes(payload, now(), ACCESS_TTL_MAX_SECONDS, claims);
    return claims;
  };
}

/** `(token) => claims` for service-to-service tokens (D-4): no tenant, scope `internal`. */
export function createServiceTokenVerifier(
  options: VerifierOptions,
): (token: string) => Promise<ServiceTokenClaims> {
  const now = options.nowSeconds ?? defaultNow;
  const cache = options.cache ?? new JwksCache(options.jwks, now);
  return async (token) => {
    const { payload } = await verifySignedToken(token, cache);
    const parsed = ServiceTokenClaims.safeParse(payload);
    if (!parsed.success) throw new TokenRejectedError('TOKEN_INVALID', 'claims');
    const claims = parsed.data;
    if (claims.aud !== options.audience) throw new TokenRejectedError('TOKEN_INVALID', 'audience');
    checkTimes(payload, now(), SERVICE_TOKEN_TTL_MAX_SECONDS, claims);
    return claims;
  };
}
