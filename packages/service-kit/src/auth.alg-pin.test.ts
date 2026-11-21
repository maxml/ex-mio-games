import { createSign } from 'node:crypto';
import { createServiceTokenVerifier, createTokenVerifier, TokenRejectedError } from './auth';
import { accessClaims, b64url, generateRsaKey, serviceClaims } from './testing/jwt-fixtures';

/*
 * Reviewer test (L1 Stage B): pins the RS256 algorithm allow-list in the verifier.
 *
 * The verifier always checks the signature with RSA-SHA256, whatever the header says, and an empty
 * signature is already refused as malformed. So the existing INV-TOK-2 cases (alg=none with an empty
 * signature, HS256/HS512) stay green when the allow-list line is deleted. The tokens below carry a
 * VALID RSA-SHA256 signature by the published key, under a header that names another algorithm.
 * Only the allow-list refuses them.
 *
 * Mutation: delete `if (header.alg !== 'RS256') throw bad('algorithm not allowed');` in auth.ts,
 * or widen it -> every case below goes red (the token is accepted).
 */

const NOW = 1_800_000_000;
const T_A = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a';
const USER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const key = generateRsaKey('k1');
const jwks = async () => ({ keys: [key.publicJwk] });

/** RSA-SHA256 signature by our key over a header that may claim any alg. */
function rsaSignedWithHeaderAlg(alg: unknown, claims: Record<string, unknown>): string {
  const input = `${b64url(JSON.stringify({ alg, typ: 'JWT', kid: 'k1' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(key.privateKey);
  return `${input}.${b64url(sig)}`;
}

const rejectedInvalid = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TokenRejectedError);
  expect((err as TokenRejectedError).code).toBe('TOKEN_INVALID');
};

describe('INV-TOK-2 (review pin): only alg RS256 is accepted, even with a valid RSA signature', () => {
  const user = createTokenVerifier({ audience: 'engagement', jwks, nowSeconds: () => NOW });
  const svc = createServiceTokenVerifier({ audience: 'payments', jwks, nowSeconds: () => NOW });
  const access = accessClaims({ now: NOW, sub: USER, tid: T_A });
  const service = serviceClaims({ now: NOW, service: 'engagement', aud: 'payments' });

  it('control: the same construction with alg RS256 is accepted', async () => {
    await expect(user(rsaSignedWithHeaderAlg('RS256', access))).resolves.toMatchObject({
      tid: T_A,
    });
    await expect(svc(rsaSignedWithHeaderAlg('RS256', service))).resolves.toMatchObject({
      sub: 'svc:engagement',
    });
  });

  it.each(['none', 'NONE', 'HS256', 'RS512', 'PS256', 'rs256', undefined, null])(
    'a header alg of %p is refused by the user and the service verifier',
    async (alg) => {
      await rejectedInvalid(user(rsaSignedWithHeaderAlg(alg, access)));
      await rejectedInvalid(svc(rsaSignedWithHeaderAlg(alg, service)));
    },
  );

  it('alg none with an empty signature is refused', async () => {
    const input = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'k1' }))}.${b64url(JSON.stringify(access))}`;
    await rejectedInvalid(user(`${input}.`));
  });
});
