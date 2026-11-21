import { ActingRequestAuditedV1, ServiceCallAuditedV1, parseEvent } from './events';
import * as identityContracts from './identity';
import { uuidv7 } from './ids';
import { COIN_VALUE_ACTIONS as PAYMENTS_COIN_VALUE_ACTIONS } from './payments';
import {
  ACCESS_TTL_MAX_SECONDS,
  ACTING_DENIED_ACTIONS,
  ACTIONS,
  AccessTokenClaims,
  AuditEntry,
  CredentialSummary,
  INTERNAL_ROUTES,
  PlayerLinkResponse,
  TenantIntegration,
  IDENTITY_ERRORS,
  INTERNAL_PATH_PREFIX,
  InternalResolvePlayerRequest,
  LaunchRequest,
  LaunchResponse,
  LoginRequest,
  OperatorSignupRequest,
  PLATFORM_TENANT_ID,
  Role,
  SERVICE_AUDIENCES,
  SERVICE_CALL_POLICY,
  ServiceTokenClaims,
  SignupResponse,
  StaffMember,
  StartActingRequest,
  TOKEN_ISSUER,
  TenantView,
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

  it('acting names the audience of its token, identity by default, and refuses an unknown one', () => {
    expect(StartActingRequest.parse({ tenant_id: U1, reason: 'ticket 42' }).audience).toBe(
      'identity',
    );
    expect(
      StartActingRequest.parse({ tenant_id: U1, reason: 'ticket 42', audience: 'payments' })
        .audience,
    ).toBe('payments');
    expect(
      StartActingRequest.safeParse({ tenant_id: U1, reason: 'x', audience: 'nobody' }).success,
    ).toBe(false);
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
  // X-10/§1. There is ONE coin-value list, owned by payments (COIN_VALUE_ACTIONS). Identity derives
  // `coins.<a>` from it and adds `redemptions.resolve` (X-11, D-15 Q-2). Mutation: delete a name
  // from payments' list, or re-declare a COIN_VALUE_ACTIONS in identity.ts (TS2308 on export *).
  it('the actions an acting session is refused are exactly these six', () => {
    expect([...ACTING_DENIED_ACTIONS].sort()).toEqual(
      [
        'coins.capture',
        'coins.credit',
        'coins.refund',
        'coins.release',
        'coins.reserve',
        'redemptions.resolve',
      ].sort(),
    );
    expect(ACTING_DENIED_ACTIONS).not.toContain('coins.adjust');
    for (const a of PAYMENTS_COIN_VALUE_ACTIONS) expect(ACTIONS).toContain(`coins.${a}`);
  });

  it('the action vocabulary is exactly these twenty-nine', () => {
    expect([...ACTIONS].sort()).toEqual(
      [
        'acting.start',
        'audit.read',
        'balance.read',
        'balance.read_own',
        'billing.manage',
        'coins.adjust',
        'coins.capture',
        'coins.credit',
        'coins.refund',
        'coins.release',
        'coins.reserve',
        'credentials.read',
        'credentials.rotate',
        'player.self.read',
        'players.read',
        'redemptions.create',
        'redemptions.read',
        'redemptions.read_own',
        'redemptions.resolve',
        'rules.manage',
        'spins.play',
        'staff.invite',
        'staff.list',
        'store.manage',
        'store.read',
        'tenant.read',
        'tenant.suspend',
        'usage.read',
        'wheel.manage',
      ].sort(),
    );
  });

  // X-3. Mutation: let `sbx` be false/any string, or drop it (zod strips it, a sandbox token turns production).
  it('X-3: sbx is `true` or absent on an access token', () => {
    const base = {
      iss: TOKEN_ISSUER,
      sub: PLATFORM_TENANT_ID,
      tid: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
      roles: ['player'],
      aud: 'engagement',
      iat: 1,
      exp: 2,
      jti: 'abcdefgh',
    };
    expect(AccessTokenClaims.parse({ ...base, sbx: true }).sbx).toBe(true);
    expect(AccessTokenClaims.parse(base).sbx).toBeUndefined();
    expect(AccessTokenClaims.safeParse({ ...base, sbx: false }).success).toBe(false);
    expect(AccessTokenClaims.safeParse({ ...base, sbx: 'true' }).success).toBe(false);
  });

  // X-7/X-8. Mutation: loosen .strict(), allow 0 or 3 secrets, make player_hash_key short.
  it('X-7: TenantIntegration carries 1..2 secrets, a hash key and an environment', () => {
    const ok = {
      tenant_id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
      platform: 'casino-a',
      status: 'active',
      environment: 'sandbox',
      webhook_secrets: ['s1'],
      player_hash_key: 'k'.repeat(32),
    };
    expect(TenantIntegration.safeParse(ok).success).toBe(true);
    expect(TenantIntegration.safeParse({ ...ok, webhook_secrets: [] }).success).toBe(false);
    expect(TenantIntegration.safeParse({ ...ok, webhook_secrets: ['a', 'b', 'c'] }).success).toBe(
      false,
    );
    expect(TenantIntegration.safeParse({ ...ok, environment: 'both' }).success).toBe(false);
    expect(TenantIntegration.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      PlayerLinkResponse.safeParse({ platform: 'casino-a', external_player_id: 'p1' }).success,
    ).toBe(true);
    expect(PlayerLinkResponse.safeParse({ platform: 'casino-a' }).success).toBe(false);
  });

  // D-15 Q-1. Mutation: re-add HEADER_WEBHOOK_* or a verifyWebhook route.
  it('D-15 Q-1: no MIO-own webhook scheme remains in the identity contracts', () => {
    expect(Object.keys(identityContracts).filter((k) => /WEBHOOK/i.test(k))).toEqual([]);
    expect(Object.keys(INTERNAL_ROUTES)).not.toContain('verifyWebhook');
  });

  // D-15 Q-4. Mutation: lower the minimum to 1.
  it('D-15 Q-4: an acting reason is 8..500 characters', () => {
    const t = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    expect(StartActingRequest.safeParse({ tenant_id: t, reason: 'x'.repeat(7) }).success).toBe(
      false,
    );
    expect(StartActingRequest.safeParse({ tenant_id: t, reason: 'x'.repeat(8) }).success).toBe(
      true,
    );
    expect(StartActingRequest.safeParse({ tenant_id: t, reason: 'x'.repeat(501) }).success).toBe(
      false,
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

// D-14: the per-client allow-list, pinned as LITERALS so widening it is a reviewed test diff.
describe('identity contracts (service call policy, D-14)', () => {
  it('engagement may call payments only reserve, capture, release, refund and the balance read', () => {
    expect([...(SERVICE_CALL_POLICY.engagement.payments ?? [])].sort()).toEqual(
      [
        'GET /internal/v1/tenants/:tenantId/players/:playerId/balance',
        'POST /internal/v1/tenants/:tenantId/reserves',
        'POST /internal/v1/tenants/:tenantId/reserves/:reserveId/capture',
        'POST /internal/v1/tenants/:tenantId/reserves/:reserveId/refund',
        'POST /internal/v1/tenants/:tenantId/reserves/:reserveId/release',
      ].sort(),
    );
  });

  it('no service may call a credit, mint or adjust route, and identity calls nobody', () => {
    expect(SERVICE_CALL_POLICY.identity).toEqual({});
    const all = Object.values(SERVICE_CALL_POLICY).flatMap((byAudience) =>
      Object.values(byAudience).flat(),
    );
    expect(all.filter((r) => /credit|mint|adjust|grant/i.test(r))).toEqual([]);
  });

  it('engagement and payments may call identity for the tenant status; only engagement may resolve players and read integrations', () => {
    expect([...(SERVICE_CALL_POLICY.engagement.identity ?? [])].sort()).toEqual(
      [
        'GET /internal/v1/integrations/by-slug/:slug',
        'GET /internal/v1/tenants/:tenantId/integration',
        'GET /internal/v1/tenants/:tenantId/players/:userId/link',
        'GET /internal/v1/tenants/:tenantId/status',
        'POST /internal/v1/tenants/:tenantId/players/resolve',
      ].sort(),
    );
    expect(SERVICE_CALL_POLICY.payments).toEqual({
      identity: ['GET /internal/v1/tenants/:tenantId/status'],
    });
  });

  it('every entry is METHOD plus an internal route template, never a prefix or a wildcard', () => {
    for (const byAudience of Object.values(SERVICE_CALL_POLICY)) {
      for (const route of Object.values(byAudience).flat()) {
        expect(route).toMatch(/^(GET|POST) \/internal\/v1\/[A-Za-z0-9/:_-]+$/);
        expect(route).not.toContain('*');
      }
    }
  });

  it('the two new error codes exist with the pinned statuses', () => {
    expect(IDENTITY_ERRORS.SERVICE_CALL_FORBIDDEN).toBe(403);
    expect(IDENTITY_ERRORS.AUDIT_UNAVAILABLE).toBe(503);
  });
});

// D-11 / D-14: the audit events every entry point writes.
describe('identity contracts (audit events, D-11 and D-14)', () => {
  const acting = {
    actor_user_id: uuidv7(),
    actor_tenant_id: PLATFORM_TENANT_ID,
    acting_tenant_id: uuidv7(),
    reason: 'ticket 42',
    service: 'payments',
    method: 'POST',
    route: 'POST /v1/credits',
    decision: 'refused',
    status: 403,
    request_id: 'req-12345678',
    occurred_at: '2026-11-21T10:00:00.000Z',
  };
  const call = {
    caller_service: 'engagement',
    service: 'payments',
    method: 'POST',
    route: 'POST /internal/v1/tenants/:tenantId/reserves',
    decision: 'allowed',
    status: 201,
    request_id: 'req-12345678',
    occurred_at: '2026-11-21T10:00:00.000Z',
  };

  it('audit.acting_request v1 is registered and strict; the route is a template, never a URL or a query', () => {
    expect(ActingRequestAuditedV1.safeParse(acting).success).toBe(true);
    expect(ActingRequestAuditedV1.safeParse({ ...acting, token: 'x' }).success).toBe(false);
    expect(
      ActingRequestAuditedV1.safeParse({ ...acting, route: 'POST /v1/credits?x=1' }).success,
    ).toBe(false);
    expect(ActingRequestAuditedV1.safeParse({ ...acting, route: 'GET /v1/credits' }).success).toBe(
      false,
    );
    expect(ActingRequestAuditedV1.safeParse({ ...acting, actor_tenant_id: uuidv7() }).success).toBe(
      false,
    );
    expect(ActingRequestAuditedV1.safeParse({ ...acting, decision: 'maybe' }).success).toBe(false);
    const env = {
      event_id: uuidv7(),
      type: 'audit.acting_request',
      version: 1,
      tenant_id: acting.acting_tenant_id,
      occurred_at: acting.occurred_at,
      correlation_id: uuidv7(),
      causation_id: null,
      payload: acting,
    };
    expect(parseEvent(env).type).toBe('audit.acting_request');
  });

  it('audit.service_call v1 is registered and strict', () => {
    expect(ServiceCallAuditedV1.safeParse(call).success).toBe(true);
    expect(ServiceCallAuditedV1.safeParse({ ...call, tenant_id: uuidv7() }).success).toBe(false);
    expect(ServiceCallAuditedV1.safeParse({ ...call, caller_service: 'web' }).success).toBe(false);
    expect(ServiceCallAuditedV1.safeParse({ ...call, route: '/internal/v1/x' }).success).toBe(
      false,
    );
  });

  it('the audit view row accepts event-derived rows with a null user actor', () => {
    expect(
      AuditEntry.safeParse({
        id: uuidv7(),
        occurred_at: call.occurred_at,
        actor_user_id: null,
        actor_tenant_id: null,
        acting_tenant_id: null,
        action: 'service.call',
        reason: '',
        service: 'payments',
        route: call.route,
        decision: 'allowed',
        caller_service: 'engagement',
      }).success,
    ).toBe(true);
  });
});

// F14 (N7): the response schemas are real shapes, so a test that parses a response with them can fail.
describe('identity contracts (response DTOs, F14)', () => {
  const T = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
  it('the response schemas refuse extra secrets and missing fields', () => {
    expect(
      CredentialSummary.safeParse({
        key_id: 'k',
        platform: 'p',
        status: 'active',
        created_at: '2026-11-21T10:00:00.000Z',
        api_key: 'secret',
      }).success,
    ).toBe(false);
    expect(StaffMember.safeParse({ id: T, email: 'a@b.co', roles: [] }).success).toBe(false);
    expect(TenantView.safeParse({ id: T, type: 'operator', name: 'a', slug: 'a' }).success).toBe(
      false,
    );
    expect(SignupResponse.safeParse({ tenant: { id: T } }).success).toBe(false);
    expect(
      LaunchResponse.safeParse({ access_token: 't', token_type: 'Bearer', expires_in: 900 })
        .success,
    ).toBe(false);
  });
});
