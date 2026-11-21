import 'reflect-metadata';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createPublicKey } from 'node:crypto';
import { lastValueFrom, of } from 'rxjs';
import {
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  JWKS_CACHE_TTL_SECONDS,
  JWKS_REFETCH_MIN_INTERVAL_SECONDS,
  PLATFORM_TENANT_ID,
} from '@ex-mio/contracts';
import * as tenancy from '@ex-mio/tenancy';
import { currentTenant, jwtTenantResolver, TenantGuard, TenantInterceptor } from '@ex-mio/tenancy';
import { createServiceTokenVerifier, createTokenVerifier, TokenRejectedError } from './auth'; // RED: module does not exist yet
import {
  accessClaims,
  b64url,
  generateRsaKey,
  serviceClaims,
  signJwt,
  tamperPayload,
} from './testing/jwt-fixtures';

/*
 * Choke point: the token verifier (service-kit/auth) and the tenant resolver
 * that feeds TenantGuard (tenancy/jwtTenantResolver). Every service verifies via
 * JWKS here; the tenant comes ONLY from the verified claim.
 *
 * Each test header names the mutation that must turn it red.
 */

const NOW = 1_800_000_000; // seconds
const T_A = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a';
const T_B = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const USER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';

const key1 = generateRsaKey('k1');
const key2 = generateRsaKey('k2');
const stranger = generateRsaKey('k1'); // same kid as key1, different key material

let jwksKeys = [key1.publicJwk];
const verifier = (audience = 'engagement') =>
  createTokenVerifier({
    audience,
    jwks: async () => ({ keys: jwksKeys }),
    nowSeconds: () => NOW,
  });

type Over = Partial<Parameters<typeof accessClaims>[0]>;
const good = (over: Over = {}) =>
  signJwt({
    alg: 'RS256',
    key: key1.privateKey,
    kid: 'k1',
    claims: accessClaims({ now: NOW, sub: USER, tid: T_A, ...over }),
  });

const rejected = async (p: Promise<unknown>, code?: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TokenRejectedError);
  if (code) expect((err as TokenRejectedError).code).toBe(code);
};

beforeEach(() => {
  jwksKeys = [key1.publicJwk];
});

describe('INV-TOK: every service trusts only tokens our key signed', () => {
  // Mutation: skip signature verification (decode only) -> this and the next two go red.
  it('INV-TOK-1 accepts a token signed by a JWKS key and returns the claims', async () => {
    const claims = await verifier()(good());
    expect(claims).toMatchObject({
      sub: USER,
      tid: T_A,
      aud: 'engagement',
      roles: ['operator_admin'],
    });
  });

  it('INV-TOK-1 rejects a token signed by an unknown key (even with a known kid)', async () => {
    const forgedKnownKid = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'k1',
      claims: accessClaims({ now: NOW, sub: USER, tid: T_A }),
    });
    const forgedUnknownKid = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'zzz',
      claims: accessClaims({ now: NOW, sub: USER, tid: T_A }),
    });
    await rejected(verifier()(forgedKnownKid), 'TOKEN_INVALID');
    await rejected(verifier()(forgedUnknownKid), 'TOKEN_INVALID');
  });

  // Mutation: verify the signature over the header only / decode the payload without re-checking.
  it('INV-TOK-1 rejects a valid token whose payload was edited without re-signing', async () => {
    await rejected(verifier()(tamperPayload(good(), { tid: T_B })), 'TOKEN_INVALID');
  });

  // Mutation: widen the algorithm allow-list (accept `none` or HS256).
  it('INV-TOK-2 rejects alg=none, HS256 with the public key as secret, and a wrong alg', async () => {
    const claims = accessClaims({ now: NOW, sub: USER, tid: T_A });
    await rejected(verifier()(signJwt({ alg: 'none', kid: 'k1', claims })), 'TOKEN_INVALID');
    await rejected(
      verifier()(signJwt({ alg: 'HS256', kid: 'k1', key: JSON.stringify(key1.publicJwk), claims })),
      'TOKEN_INVALID',
    );
    await rejected(
      verifier()(signJwt({ alg: 'HS512', kid: 'k1', key: key1.publicJwk.n ?? '', claims })),
      'TOKEN_INVALID',
    );
  });

  // Mutation: widen the allow-list to HS256 (the classic RS256 -> HS256 confusion: the public
  // key in PEM form is the HMAC secret). F12: the previous variant used a JSON string as secret,
  // so a verifier that wrongly allowed HS256 with the PEM was not caught.
  it('INV-TOK-2 rejects HS256/HS512 signed with the SPKI PEM of the public key as the secret', async () => {
    const pem = createPublicKey({ key: key1.publicJwk as never, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const claims = accessClaims({ now: NOW, sub: USER, tid: T_A });
    for (const alg of ['HS256', 'HS512'] as const) {
      await rejected(verifier()(signJwt({ alg, kid: 'k1', key: pem, claims })), 'TOKEN_INVALID');
    }
  });

  // Mutation: fall back to the first JWKS key when the header has no kid.
  it('INV-TOK-2 a validly signed token without a kid header is rejected (a kid is required)', async () => {
    const claims = accessClaims({ now: NOW, sub: USER, tid: T_A });
    await rejected(
      verifier()(signJwt({ alg: 'RS256', key: key1.privateKey, claims })),
      'TOKEN_INVALID',
    );
  });

  it('INV-TOK-2 rejects garbage that is not a JWT', async () => {
    for (const junk of ['', 'a.b', 'a.b.c', `${b64url('{}')}.${b64url('{}')}.`]) {
      await rejected(verifier()(junk), 'TOKEN_INVALID');
    }
  });

  // Mutation: drop the `aud` comparison.
  it('INV-TOK-3 a token minted for payments is rejected by engagement', async () => {
    const token = good({ aud: 'payments' });
    await rejected(verifier('engagement')(token), 'TOKEN_INVALID');
    await expect(verifier('payments')(token)).resolves.toMatchObject({ aud: 'payments' });
  });

  // Mutation: drop the `exp` check (or compare against iat instead of now).
  it('INV-TOK-4 an expired token is rejected with TOKEN_EXPIRED (past the 30 s leeway)', async () => {
    const token = good({ ttl: 60 });
    const late = createTokenVerifier({
      audience: 'engagement',
      jwks: async () => ({ keys: jwksKeys }),
      nowSeconds: () => NOW + 60 + ACCESS_TOKEN_CLOCK_SKEW_SECONDS + 1,
    });
    await rejected(late(token), 'TOKEN_EXPIRED');
  });

  // Mutation: remove the TTL cap (ACCESS_TTL_MAX_SECONDS = 900).
  it('INV-TOK-4 a token valid for longer than 900 s is rejected even if signed by us', async () => {
    await rejected(verifier()(good({ ttl: 901 })), 'TOKEN_INVALID');
    await expect(verifier()(good({ ttl: 900 }))).resolves.toBeDefined();
  });

  // Mutation: make tid optional in the claim schema.
  it('INV-TOK-5 a token without tid, with a non-UUID tid, without roles or with a wrong issuer is rejected', async () => {
    const base = accessClaims({ now: NOW, sub: USER, tid: T_A });
    const sign = (claims: Record<string, unknown>) =>
      signJwt({ alg: 'RS256', key: key1.privateKey, kid: 'k1', claims });
    const { tid: _t, ...noTid } = base;
    await rejected(verifier()(sign(noTid)), 'TOKEN_INVALID');
    await rejected(verifier()(sign({ ...base, tid: 'not-a-uuid' })), 'TOKEN_INVALID');
    await rejected(verifier()(sign({ ...base, roles: [] })), 'TOKEN_INVALID');
    await rejected(verifier()(sign({ ...base, roles: ['root'] })), 'TOKEN_INVALID');
    await rejected(verifier()(sign({ ...base, iss: 'someone-else' })), 'TOKEN_INVALID');
  });

  // F1: ONE verifier instance across the JWKS change, so its cache is what is under test. The
  // cache policy is pinned as numbers (contracts): key set cached JWKS_CACHE_TTL_SECONDS (300 s);
  // an unknown kid refetches, at most once per JWKS_REFETCH_MIN_INTERVAL_SECONDS (30 s); a failed
  // fetch fails closed (no stale-if-error).
  describe('INV-TOK-6 JWKS cache and key rotation (one verifier instance)', () => {
    let clock = NOW;
    let fetches = 0;
    let fail = false;
    const longLived = (key: typeof key1, kid: string) =>
      signJwt({
        alg: 'RS256',
        key: key.privateKey,
        kid,
        claims: accessClaims({ now: NOW, sub: USER, tid: T_A, ttl: 900 }),
      });
    const instance = () =>
      createTokenVerifier({
        audience: 'engagement',
        jwks: async () => {
          fetches++;
          if (fail) throw new Error('identity unreachable');
          return { keys: jwksKeys };
        },
        nowSeconds: () => clock,
      });
    beforeEach(() => {
      clock = NOW;
      fetches = 0;
      fail = false;
    });

    // Mutation: drop the cache (fetch on every verification) -> the fetch count rises.
    it('the key set is fetched once and reused for every token inside the TTL', async () => {
      const verify = instance();
      for (let i = 0; i < 5; i++) await verify(good());
      expect(fetches).toBe(1);
    });

    // Mutation: cache forever -> the removed key keeps verifying after the TTL.
    it('a removed key stops verifying once the cache TTL passed, and not a second earlier', async () => {
      const verify = instance();
      const oldToken = longLived(key1, 'k1');
      await expect(verify(oldToken)).resolves.toBeDefined();
      jwksKeys = [key2.publicJwk];
      clock = NOW + JWKS_CACHE_TTL_SECONDS - 1;
      await expect(verify(oldToken)).resolves.toBeDefined(); // still the cached key set
      expect(fetches).toBe(1);
      clock = NOW + JWKS_CACHE_TTL_SECONDS;
      await rejected(verify(oldToken), 'TOKEN_INVALID');
      expect(fetches).toBe(2);
    });

    // Mutation: never refetch on an unknown kid -> a freshly rotated-in key is refused until the TTL.
    it('a key added after the cache was filled verifies after one refetch on its unknown kid', async () => {
      const verify = instance();
      await verify(good()); // cache [k1] at NOW
      jwksKeys = [key1.publicJwk, key2.publicJwk];
      clock = NOW + JWKS_REFETCH_MIN_INTERVAL_SECONDS + 1;
      await expect(verify(longLived(key2, 'k2'))).resolves.toBeDefined();
      expect(fetches).toBe(2);
      await expect(verify(good())).resolves.toBeDefined(); // the old key still verifies
    });

    // Mutation: refetch on every unknown kid -> a stream of random kids is a stream of fetches.
    it('random kids cannot force a fetch per request: at most one refetch per 30 s', async () => {
      const verify = instance();
      await verify(good());
      clock = NOW + JWKS_REFETCH_MIN_INTERVAL_SECONDS + 1;
      for (let i = 0; i < 10; i++) {
        await rejected(verify(longLived(stranger, `random-${i}`)), 'TOKEN_INVALID');
      }
      expect(fetches).toBe(2); // the warm-up plus ONE refetch for ten unknown kids
    });

    // Mutation: serve the stale key set when the fetch fails (stale-if-error) or accept without keys.
    it('a failing JWKS fetch fails closed: TOKEN_INVALID after the TTL, and the verifier recovers', async () => {
      const verify = instance();
      await verify(good());
      fail = true;
      clock = NOW + JWKS_CACHE_TTL_SECONDS;
      await rejected(verify(good()), 'TOKEN_INVALID');
      fail = false;
      await expect(verify(good())).resolves.toBeDefined();
    });

    it('a fetch failure on a cold cache is TOKEN_INVALID, never an accept', async () => {
      fail = true;
      await rejected(instance()(good()), 'TOKEN_INVALID');
    });

    // Mutation: ignore kid (use the first key).
    it('the key is chosen by kid: a k2 token is not checked against k1', async () => {
      jwksKeys = [key1.publicJwk, key2.publicJwk];
      const verify = instance();
      await expect(verify(longLived(key2, 'k2'))).resolves.toBeDefined();
      await rejected(verify(longLived(key2, 'k1')), 'TOKEN_INVALID'); // k2 material under k1's kid
    });
  });

  // Mutation: honour `act` regardless of role.
  it('INV-TOK-7 an act claim is accepted only on a platform_admin token', async () => {
    const act = { tenant_id: T_B, reason: 'ticket 42' };
    await expect(
      verifier()(good({ roles: ['platform_admin'], tid: PLATFORM_TENANT_ID, act })),
    ).resolves.toMatchObject({ act });
    await rejected(verifier()(good({ roles: ['operator_admin'], act })), 'TOKEN_INVALID');
    await rejected(verifier()(good({ roles: ['operator_staff', 'player'], act })), 'TOKEN_INVALID');
  });

  it('INV-TOK-7 an act claim added to a valid operator token without re-signing is rejected', async () => {
    const forged = tamperPayload(good({ roles: ['operator_admin'] }), {
      act: { tenant_id: T_B, reason: 'x' },
    });
    await rejected(verifier()(forged), 'TOKEN_INVALID');
  });

  it('INV-TOK-7 an acting token lives at most 900 s', async () => {
    const act = { tenant_id: T_B, reason: 'ticket 42' };
    const acting = (ttl: number) =>
      good({ roles: ['platform_admin'], tid: PLATFORM_TENANT_ID, act, ttl });
    await rejected(verifier()(acting(901)), 'TOKEN_INVALID');
    await expect(verifier()(acting(900))).resolves.toBeDefined();
  });

  // F8. Mutation: drop the platform binding from the claim schema (the role is honoured on any tid).
  it('INV-TOK-8 platform_admin is valid only on PLATFORM_TENANT_ID and only alone', async () => {
    const admin = (over: Over) =>
      good({ tid: PLATFORM_TENANT_ID, roles: ['platform_admin'], ...over });
    await expect(verifier()(admin({}))).resolves.toMatchObject({ tid: PLATFORM_TENANT_ID });
    await rejected(verifier()(admin({ tid: T_A })), 'TOKEN_INVALID');
    await rejected(
      verifier()(admin({ tid: T_A, act: { tenant_id: T_B, reason: 'x' } })),
      'TOKEN_INVALID',
    );
    await rejected(
      verifier()(admin({ roles: ['platform_admin', 'operator_admin'] })),
      'TOKEN_INVALID',
    );
  });

  // Mutation: let operator roles through on the platform tenant id.
  it('INV-TOK-8 the platform tenant id carries nothing but platform_admin', async () => {
    await rejected(
      verifier()(good({ tid: PLATFORM_TENANT_ID, roles: ['operator_admin'] })),
      'TOKEN_INVALID',
    );
    await rejected(
      verifier()(good({ tid: PLATFORM_TENANT_ID, roles: ['player'] })),
      'TOKEN_INVALID',
    );
  });
});

describe('INV-TOK-9 clock skew leeway is 30 s on exp, nbf and iat (D-6, Q3)', () => {
  const at = (now: number) =>
    createTokenVerifier({
      audience: 'engagement',
      jwks: async () => ({ keys: [key1.publicJwk] }),
      nowSeconds: () => now,
    });
  const withClaims = (extra: Record<string, unknown>, ttl = 600, iat = NOW) =>
    signJwt({
      alg: 'RS256',
      key: key1.privateKey,
      kid: 'k1',
      claims: { ...accessClaims({ now: iat, sub: USER, tid: T_A, ttl }), ...extra },
    });

  // Mutation: no leeway (compare exp to now exactly) / a leeway of 300.
  it('exp: accepted up to 30 s after expiry, TOKEN_EXPIRED from 31 s', async () => {
    const token = withClaims({}, 60);
    await expect(at(NOW + 60 + ACCESS_TOKEN_CLOCK_SKEW_SECONDS)(token)).resolves.toBeDefined();
    await rejected(at(NOW + 60 + ACCESS_TOKEN_CLOCK_SKEW_SECONDS + 1)(token), 'TOKEN_EXPIRED');
  });

  // Mutation: skip the iat-in-the-future check.
  it('iat: accepted up to 30 s in the future, TOKEN_INVALID from 31 s', async () => {
    const token = withClaims({}, 600, NOW + ACCESS_TOKEN_CLOCK_SKEW_SECONDS);
    await expect(at(NOW)(token)).resolves.toBeDefined();
    await rejected(
      at(NOW)(withClaims({}, 600, NOW + ACCESS_TOKEN_CLOCK_SKEW_SECONDS + 1)),
      'TOKEN_INVALID',
    );
  });

  // Mutation: ignore nbf.
  it('nbf: honoured when present, with the same 30 s leeway', async () => {
    await expect(
      at(NOW)(withClaims({ nbf: NOW + ACCESS_TOKEN_CLOCK_SKEW_SECONDS })),
    ).resolves.toBeDefined();
    await rejected(
      at(NOW)(withClaims({ nbf: NOW + ACCESS_TOKEN_CLOCK_SKEW_SECONDS + 1 })),
      'TOKEN_INVALID',
    );
  });
});

describe('INV-TOK-10 service tokens (D-4): a user token cannot be a service token and the reverse', () => {
  const svcVerifier = (audience = 'payments') =>
    createServiceTokenVerifier({
      audience,
      jwks: async () => ({ keys: jwksKeys }),
      nowSeconds: () => NOW,
    });
  const svc = (over: Partial<Parameters<typeof serviceClaims>[0]> = {}, extra = {}) =>
    signJwt({
      alg: 'RS256',
      key: key1.privateKey,
      kid: 'k1',
      claims: serviceClaims({ now: NOW, service: 'engagement', aud: 'payments', ...over, extra }),
    });

  it('accepts a service token with the right audience and returns sub and scope', async () => {
    await expect(svcVerifier()(svc())).resolves.toMatchObject({
      sub: 'svc:engagement',
      aud: 'payments',
      scope: 'internal',
    });
  });

  // Mutation: the user verifier accepts a service token (the claim schema is shared).
  it('a service token is rejected by the user-token verifier (no tid, no roles)', async () => {
    await rejected(verifier('payments')(svc()), 'TOKEN_INVALID');
  });

  // Mutation: the service verifier accepts a user token.
  it('a user token is rejected by the service-token verifier', async () => {
    await rejected(svcVerifier('engagement')(good()), 'TOKEN_INVALID');
  });

  // Mutation: drop the aud comparison on the service verifier.
  it('a service token minted for engagement is refused by payments', async () => {
    await rejected(svcVerifier('payments')(svc({ aud: 'engagement' })), 'TOKEN_INVALID');
  });

  // Mutation: let a service token carry a tenant, roles or act.
  it('a service token that carries tid, roles or act is rejected (it carries no tenant)', async () => {
    await rejected(svcVerifier()(svc({}, { tid: T_A })), 'TOKEN_INVALID');
    await rejected(svcVerifier()(svc({}, { roles: ['platform_admin'] })), 'TOKEN_INVALID');
    await rejected(
      svcVerifier()(svc({}, { act: { tenant_id: T_B, reason: 'x' } })),
      'TOKEN_INVALID',
    );
  });

  // Mutation: do not check scope / sub shape.
  it('a wrong scope, a sub that is not svc:<name>, or a TTL above 300 s is rejected', async () => {
    await rejected(svcVerifier()(svc({ scope: 'coins:write' })), 'TOKEN_INVALID');
    await rejected(svcVerifier()(svc({ service: 'a-user' })), 'TOKEN_INVALID');
    await rejected(svcVerifier()(svc({ ttl: 301 })), 'TOKEN_INVALID');
    await expect(svcVerifier()(svc({ ttl: 300 }))).resolves.toBeDefined();
  });

  // Mutation: skip signature verification for service tokens.
  it('a service token signed by an unknown key, or expired, is rejected', async () => {
    const forged = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'k1',
      claims: serviceClaims({ now: NOW, service: 'engagement', aud: 'payments' }),
    });
    await rejected(svcVerifier()(forged), 'TOKEN_INVALID');
    const late = createServiceTokenVerifier({
      audience: 'payments',
      jwks: async () => ({ keys: jwksKeys }),
      nowSeconds: () => NOW + 300 + ACCESS_TOKEN_CLOCK_SKEW_SECONDS + 1,
    });
    await rejected(late(svc()), 'TOKEN_EXPIRED');
  });
});

describe('INV-TENANT: the tenant comes only from the verified claim', () => {
  const guardFor = () => new TenantGuard(new Reflector(), jwtTenantResolver(verifier()));
  const ctxFor = (request: Record<string, unknown>) =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  // canActivate is async once the verifier is async; a sync throw is also a rejection here.
  const admit = async (guard: TenantGuard, ctx: ExecutionContext) => guard.canActivate(ctx);

  // Mutation: re-add headerTenantResolver as the fallback.
  it('INV-TENANT-1 the x-tenant-id placeholder is gone: header alone is 401', async () => {
    await expect(
      admit(guardFor(), ctxFor({ headers: { 'x-tenant-id': T_A } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect('headerTenantResolver' in tenancy).toBe(false);
    expect('TENANT_HEADER' in tenancy).toBe(false);
    expect('PRINCIPAL_HEADER' in tenancy).toBe(false);
  });

  it('INV-TENANT-1 a guard built without a resolver still denies a header-only request', async () => {
    await expect(
      admit(
        new TenantGuard(new Reflector()),
        ctxFor({ headers: { 'x-tenant-id': T_A, 'x-principal-id': 'p' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // Mutation: prefer the header/query/body tenant over the claim.
  it('INV-TENANT-2 a token for A with a header, query and body naming B is served as A', async () => {
    const request: Record<string, unknown> = {
      headers: { ...bearer(good()), 'x-tenant-id': T_B, host: `${T_B}.example.test` },
      query: { tenant_id: T_B },
      body: { tenant_id: T_B },
      params: { tenantId: T_B },
    };
    const ctx = ctxFor(request);
    await guardFor().canActivate(ctx);
    const seen = await lastValueFrom(
      new TenantInterceptor().intercept(ctx, { handle: () => of(currentTenant()) }) as never,
    );
    expect(seen).toEqual({ tenantId: T_A, principalId: USER });
  });

  // Mutation: fall through to a default tenant when verification fails.
  it('INV-TENANT-3 no token, a forged token, a missing tid claim: all 401, never a default tenant', async () => {
    const forged = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'k1',
      claims: accessClaims({ now: NOW, sub: USER, tid: T_A }),
    });
    const { tid: _t, ...noTid } = accessClaims({ now: NOW, sub: USER, tid: T_A });
    const missing = signJwt({ alg: 'RS256', key: key1.privateKey, kid: 'k1', claims: noTid });
    for (const headers of [
      {},
      bearer(forged),
      bearer(missing),
      { authorization: 'Basic abc' },
      { authorization: 'Bearer ' },
    ]) {
      await expect(admit(guardFor(), ctxFor({ headers }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  // Mutation: ignore `act` in the resolver (platform admin acts as the platform tenant).
  it('INV-TENANT-4 a platform_admin acting token is served as the acting tenant, with the real actor as principal', async () => {
    const token = good({
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
      act: { tenant_id: T_B, reason: 'support ticket' },
    });
    const ctx = ctxFor({ headers: bearer(token) });
    await guardFor().canActivate(ctx);
    const seen = await lastValueFrom(
      new TenantInterceptor().intercept(ctx, { handle: () => of(currentTenant()) }) as never,
    );
    expect(seen).toEqual({ tenantId: T_B, principalId: USER });
  });
});
