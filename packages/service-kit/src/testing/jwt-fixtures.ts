import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

// Test-only token signing. It is deliberately independent of the production
// verifier and issuer (no jose, no shared code), so a test that forges a token
// does not share a bug with the code that is supposed to reject it.

export const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export interface RsaFixtureKey {
  kid: string;
  privateKey: KeyObject;
  /** Public JWK with `kid`, `alg`, `use` set, the shape a JWKS endpoint serves. */
  publicJwk: Record<string, string>;
}

export function generateRsaKey(kid: string): RsaFixtureKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

export interface SignOptions {
  /** `none` yields an unsigned token. */
  alg: 'RS256' | 'HS256' | 'HS512' | 'none';
  /** RS256: a private KeyObject. HS*: the secret (string or Buffer). none: ignored. */
  key?: KeyObject | string | Buffer;
  kid?: string;
  claims: Record<string, unknown>;
  header?: Record<string, unknown>;
}

export function signJwt(opts: SignOptions): string {
  const header = {
    alg: opts.alg,
    typ: 'JWT',
    ...(opts.kid ? { kid: opts.kid } : {}),
    ...opts.header,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(opts.claims))}`;
  if (opts.alg === 'none') return `${signingInput}.`;
  if (opts.alg === 'RS256') {
    const sig = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(opts.key as KeyObject);
    return `${signingInput}.${b64url(sig)}`;
  }
  const hash = opts.alg === 'HS256' ? 'sha256' : 'sha512';
  return `${signingInput}.${b64url(
    createHmac(hash, opts.key as string | Buffer)
      .update(signingInput)
      .digest(),
  )}`;
}

/** Replace the payload of a signed token without re-signing (a tampered token). */
export function tamperPayload(token: string, patch: Record<string, unknown>): string {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  return `${h}.${b64url(JSON.stringify({ ...payload, ...patch }))}.${s}`;
}

export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

export function decodeHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
}

/** Access-token claims as identity would issue them, for tests that need a valid-looking set. */
export function accessClaims(over: {
  now: number; // seconds
  sub: string;
  tid: string;
  roles?: string[];
  /** D-22: a player session carries an array (engagement, payments, realtime). */
  aud?: string | string[];
  ttl?: number;
  act?: { tenant_id: string; reason: string };
  /** X-3: a player token launched through a sandbox credential. Absent means production. */
  sbx?: true;
  jti?: string;
}): Record<string, unknown> {
  return {
    iss: 'ex-mio-identity',
    sub: over.sub,
    tid: over.tid,
    roles: over.roles ?? ['operator_admin'],
    aud: over.aud ?? 'engagement',
    iat: over.now,
    exp: over.now + (over.ttl ?? 600),
    jti: over.jti ?? 'jti-0000000001',
    ...(over.act ? { act: over.act } : {}),
    ...(over.sbx ? { sbx: true } : {}),
  };
}

/** Service-to-service token claims as identity issues them: no tenant, no roles, scope `internal`. */
export function serviceClaims(over: {
  now: number; // seconds
  service: string; // calling service name, `sub` becomes `svc:<service>`
  aud: string;
  ttl?: number;
  scope?: string;
  jti?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    iss: 'ex-mio-identity',
    sub: `svc:${over.service}`,
    aud: over.aud,
    scope: over.scope ?? 'internal',
    iat: over.now,
    exp: over.now + (over.ttl ?? 300),
    jti: over.jti ?? 'svc-jti-0000001',
    ...over.extra,
  };
}

/** What a casino does: sign a launch token with the HMAC secret issued to it (HS256 JWT, `kid` = key id). */
export function signLaunchToken(opts: {
  keyId: string;
  secret: string;
  now: number; // seconds
  externalPlayerId: string;
  platform?: string;
  ttl?: number;
  aud?: string;
  jti?: string;
  iat?: number;
  alg?: 'HS256' | 'HS512' | 'none';
  extra?: Record<string, unknown>;
}): string {
  return signJwt({
    alg: opts.alg ?? 'HS256',
    key: opts.secret,
    kid: opts.keyId,
    claims: {
      pid: opts.externalPlayerId,
      plat: opts.platform ?? 'sim-casino',
      aud: opts.aud ?? 'mio-launch',
      iat: opts.iat ?? opts.now,
      exp: (opts.iat ?? opts.now) + (opts.ttl ?? 120),
      jti: opts.jti ?? `nonce-${Math.random().toString(36).slice(2)}${Date.now()}`,
      ...opts.extra,
    },
  });
}

/** Casino webhook signature: hex HMAC-SHA256 over `${timestamp}.${rawBody}`. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
