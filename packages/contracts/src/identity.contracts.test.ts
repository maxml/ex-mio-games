import {
  ACCESS_TTL_MAX_SECONDS,
  AccessTokenClaims,
  IDENTITY_ERRORS,
  LaunchRequest,
  LoginRequest,
  OperatorSignupRequest,
  StartActingRequest,
  TOKEN_ISSUER,
  TokenResponse,
} from './identity';

// These pin the SHAPES only. They are green at the end of Stage A by design: the
// schemas are the contract. Behaviour is pinned by the red tests listed in
// docs/specs/identity.md.

const U1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const U2 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';

describe('identity contracts (shape)', () => {
  const claims = {
    iss: TOKEN_ISSUER,
    sub: U1,
    tid: U2,
    roles: ['operator_admin'],
    aud: 'engagement',
    iat: 1,
    exp: 2,
    jti: 'abcdefgh',
  };

  it('accepts a well-formed access token claim set', () => {
    expect(AccessTokenClaims.safeParse(claims).success).toBe(true);
  });

  it('rejects a claim set without tid, with an unknown role or an unknown audience', () => {
    const { tid: _tid, ...noTid } = claims;
    expect(AccessTokenClaims.safeParse(noTid).success).toBe(false);
    expect(AccessTokenClaims.safeParse({ ...claims, roles: ['root'] }).success).toBe(false);
    expect(AccessTokenClaims.safeParse({ ...claims, aud: 'other' }).success).toBe(false);
  });

  it('a login body cannot carry a tenant id', () => {
    expect(LoginRequest.safeParse({ email: 'a@b.co', password: 'x', tenant_id: U1 }).success).toBe(
      false,
    );
  });

  it('a launch body cannot name a player', () => {
    expect(
      LaunchRequest.safeParse({ token: 'x'.repeat(30), external_player_id: 'p1' }).success,
    ).toBe(false);
  });

  it('acting needs a non-blank reason', () => {
    expect(StartActingRequest.safeParse({ tenant_id: U1, reason: '   ' }).success).toBe(false);
    expect(StartActingRequest.safeParse({ tenant_id: U1, reason: 'ticket 42' }).success).toBe(true);
  });

  it('signup normalises email and rejects unknown fields', () => {
    const ok = OperatorSignupRequest.parse({
      tenant_name: 'Acme',
      slug: 'acme',
      email: ' Boss@Acme.COM ',
      password: 'correct horse battery',
    });
    expect(ok.email).toBe('boss@acme.com');
    expect(OperatorSignupRequest.safeParse({ ...ok, roles: ['platform_admin'] }).success).toBe(
      false,
    );
  });

  it('a token response cannot advertise a TTL above the cap', () => {
    expect(
      TokenResponse.safeParse({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_MAX_SECONDS + 1,
      }).success,
    ).toBe(false);
  });

  it('every error code maps to a 4xx/5xx status', () => {
    for (const status of Object.values(IDENTITY_ERRORS)) {
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });
});
