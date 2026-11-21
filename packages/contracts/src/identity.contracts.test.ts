import {
  ACCESS_TTL_MAX_SECONDS,
  ACTIONS,
  AccessTokenClaims,
  COIN_VALUE_ACTIONS,
  IDENTITY_ERRORS,
  INTERNAL_PATH_PREFIX,
  InternalResolvePlayerRequest,
  LaunchRequest,
  LoginRequest,
  OperatorSignupRequest,
  PLATFORM_TENANT_ID,
  Role,
  SERVICE_AUDIENCES,
  ServiceTokenClaims,
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

// Pinned as LITERALS, not read from the constants they pin (review finding F4): shrinking or
// growing one of these lists must fail here, in a reviewed test diff, not pass silently.
describe('identity contracts (pinned vocabularies)', () => {
  it('the coin actions that move value are exactly these five', () => {
    expect([...COIN_VALUE_ACTIONS].sort()).toEqual(
      ['coins.capture', 'coins.credit', 'coins.hold', 'coins.refund', 'coins.release'].sort(),
    );
  });

  it('the action vocabulary is exactly these sixteen', () => {
    expect([...ACTIONS].sort()).toEqual(
      [
        'acting.start',
        'audit.read',
        'coins.adjust',
        'coins.capture',
        'coins.credit',
        'coins.hold',
        'coins.refund',
        'coins.release',
        'credentials.read',
        'credentials.rotate',
        'player.self.read',
        'players.read',
        'staff.invite',
        'staff.list',
        'tenant.read',
        'tenant.suspend',
      ].sort(),
    );
  });

  it('the roles and the audiences are exactly these', () => {
    expect([...Role.options].sort()).toEqual(
      ['operator_admin', 'operator_staff', 'platform_admin', 'player'].sort(),
    );
    expect([...SERVICE_AUDIENCES].sort()).toEqual(['engagement', 'identity', 'payments', 'web']);
  });

  it('the platform tenant id and the internal prefix are fixed', () => {
    expect(PLATFORM_TENANT_ID).toBe('00000000-0000-7000-8000-000000000001');
    expect(INTERNAL_PATH_PREFIX).toBe('/internal/v1/');
  });
});

describe('identity contracts (token binding, D-4)', () => {
  const T = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
  const base = {
    iss: TOKEN_ISSUER,
    sub: T,
    aud: 'engagement',
    iat: 1,
    exp: 2,
    jti: 'abcdefgh',
  };

  it('platform_admin is valid only alone and only on the platform tenant', () => {
    const ok = { ...base, tid: PLATFORM_TENANT_ID, roles: ['platform_admin'] };
    expect(AccessTokenClaims.safeParse(ok).success).toBe(true);
    expect(AccessTokenClaims.safeParse({ ...ok, tid: T }).success).toBe(false);
    expect(
      AccessTokenClaims.safeParse({ ...ok, roles: ['platform_admin', 'operator_admin'] }).success,
    ).toBe(false);
    expect(
      AccessTokenClaims.safeParse({ ...base, tid: PLATFORM_TENANT_ID, roles: ['operator_admin'] })
        .success,
    ).toBe(false);
  });

  it('a service token has no tenant, no roles and no act', () => {
    const svc = {
      iss: TOKEN_ISSUER,
      sub: 'svc:engagement',
      aud: 'payments',
      scope: 'internal',
      iat: 1,
      exp: 2,
      jti: 'abcdefgh',
    };
    expect(ServiceTokenClaims.safeParse(svc).success).toBe(true);
    expect(ServiceTokenClaims.safeParse({ ...svc, tid: T }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...svc, roles: ['player'] }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...svc, scope: 'coins:write' }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...svc, sub: T }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...svc, aud: 'web' }).success).toBe(false);
  });

  it('an internal resolve body cannot carry the tenant (it is in the path)', () => {
    expect(
      InternalResolvePlayerRequest.safeParse({
        platform: 'sim-casino',
        external_player_id: 'p1',
        tenant_id: T,
      }).success,
    ).toBe(false);
  });
});
