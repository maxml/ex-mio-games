import 'reflect-metadata';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import * as tenancy from '@ex-mio/tenancy';
import { currentTenant, jwtTenantResolver, TenantGuard, TenantInterceptor } from '@ex-mio/tenancy';
import { createTokenVerifier, TokenRejectedError } from './auth'; // RED: module does not exist yet
import {
  accessClaims,
  b64url,
  generateRsaKey,
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
  it('INV-TOK-4 an expired token is rejected with TOKEN_EXPIRED', async () => {
    const token = good({ ttl: 60 });
    const late = createTokenVerifier({
      audience: 'engagement',
      jwks: async () => ({ keys: jwksKeys }),
      nowSeconds: () => NOW + 61,
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

  // Mutation: cache the key set forever / ignore kid.
  it('INV-TOK-6 key rotation: tokens from the previous key verify while it is in the JWKS, not after', async () => {
    const oldToken = good();
    const newToken = signJwt({
      alg: 'RS256',
      key: key2.privateKey,
      kid: 'k2',
      claims: accessClaims({ now: NOW, sub: USER, tid: T_A }),
    });
    jwksKeys = [key1.publicJwk, key2.publicJwk];
    await expect(verifier()(oldToken)).resolves.toBeDefined();
    await expect(verifier()(newToken)).resolves.toBeDefined();
    jwksKeys = [key2.publicJwk];
    await rejected(verifier()(oldToken), 'TOKEN_INVALID');
  });

  // Mutation: honour `act` regardless of role.
  it('INV-TOK-7 an act claim is accepted only on a platform_admin token', async () => {
    const act = { tenant_id: T_B, reason: 'ticket 42' };
    await expect(verifier()(good({ roles: ['platform_admin'], act }))).resolves.toMatchObject({
      act,
    });
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
    await rejected(verifier()(good({ roles: ['platform_admin'], act, ttl: 901 })), 'TOKEN_INVALID');
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
      tid: T_A,
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
