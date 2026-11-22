import { z } from 'zod';
import { CasinoRewardApiConfig, IssueDeadlineMs } from './casino-adapter';
import { Uuid } from './ids';
import { COIN_VALUE_ACTIONS } from './payments';

// Identity contracts (feature spec). Spec: docs/specs/identity.md. Every service
// parses tokens with these shapes; nothing else defines what a claim means.

// ---- vocabulary ------------------------------------------------------------

export const TenantType = z.enum(['platform', 'operator']);
export type TenantType = z.infer<typeof TenantType>;

export const TenantStatus = z.enum(['active', 'suspended']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const Role = z.enum(['platform_admin', 'operator_admin', 'operator_staff', 'player']);
export type Role = z.infer<typeof Role>;

/**
 * Audiences a token can be minted for. A token has exactly one, except a player session, which
 * carries `PLAYER_SESSION_AUDIENCES` (D-22, D-23). `realtime` exists only on the one-time socket
 * ticket (D-10): login, acting and launch bodies cannot ask for it (`RequestedAudience`).
 */
export const SERVICE_AUDIENCES = ['identity', 'engagement', 'payments', 'realtime', 'web'] as const;
export const Audience = z.enum(SERVICE_AUDIENCES);
export type Audience = z.infer<typeof Audience>;

/** What a login, acting or launch body may ask for: every audience except `realtime`. */
export const REQUESTABLE_AUDIENCES = ['identity', 'engagement', 'payments', 'web'] as const;
export const RequestedAudience = z.enum(REQUESTABLE_AUDIENCES);
export type RequestedAudience = z.infer<typeof RequestedAudience>;

/**
 * D-23: the `aud` array of a player session. It includes `identity` so the player can call the
 * ticket route with it, and never `realtime`: only the ticket carries that.
 */
export const PLAYER_SESSION_AUDIENCES = ['identity', 'engagement', 'payments'] as const;

/** D-10, D-22: a socket ticket lives at most this long and is redeemed once. */
export const REALTIME_TICKET_TTL_SECONDS = 60;

/**
 * The platform tenant has a fixed id, seeded by the identity migration. The token
 * verifier (not only the database) binds the `platform_admin` role to it: a token
 * carrying that role for any other tenant is refused by every service.
 */
export const PLATFORM_TENANT_ID = '00000000-0000-7000-8000-000000000001';

export const TOKEN_ISSUER = 'ex-mio-identity';
export const ACCESS_TTL_MAX_SECONDS = 900;
/** Leeway on `exp`, `nbf` and `iat` of access and service tokens (coordinator decision D-6, Q3). */
export const ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 30;
/** JWKS cache policy of the service-kit verifier (spec section 1.4). */
export const JWKS_CACHE_TTL_SECONDS = 300;
export const JWKS_REFETCH_MIN_INTERVAL_SECONDS = 30;
/** The verifier's cached tenant status is at most this stale (D-6, Q1). */
export const TENANT_STATUS_CACHE_SECONDS = 30;
/** Service-to-service tokens (D-4). */
export const SERVICE_TOKEN_TTL_MAX_SECONDS = 300;
export const SERVICE_TOKEN_SCOPE = 'internal';
export const INTERNAL_PATH_PREFIX = '/internal/v1/';
export const ACTING_TTL_MAX_SECONDS = 900;
export const LAUNCH_TOKEN_MAX_TTL_SECONDS = 300;
export const LAUNCH_TOKEN_CLOCK_SKEW_SECONDS = 60;
export const LAUNCH_TOKEN_AUDIENCE = 'mio-launch';
export const LAUNCH_TOKEN_ALGS = ['HS256'] as const;
export const ACCESS_TOKEN_ALGS = ['RS256'] as const;

// D-15 Q-1: webhooks carry the casino's own signature, verified in the engagement adapters. MIO's
// own `x-mio-*` scheme and the identity `webhooks/verify` route are dropped. Identity serves the
// secrets to `svc:engagement` only, through the integration routes below (X-7).

// ---- actions (the vocabulary of can(subject, action, object)) ---------------

export const ACTIONS = [
  'tenant.read',
  'tenant.suspend',
  'staff.invite',
  'staff.list',
  'players.read',
  'player.self.read',
  'credentials.read',
  'credentials.rotate',
  'audit.read',
  'acting.start',
  'coins.credit',
  'coins.reserve',
  'coins.capture',
  'coins.release',
  'coins.refund',
  'coins.adjust',
  // X-15: the engagement, store, rules, wheel, billing and balance actions. The role matrix is
  // pinned by INV-RBAC-1 in identity.access.test.ts.
  'spins.play',
  'store.read',
  'store.manage',
  'redemptions.create',
  'redemptions.read_own',
  'redemptions.read',
  'redemptions.resolve',
  'rules.manage',
  'wheel.manage',
  'balance.read_own',
  'balance.read',
  'billing.manage',
  'usage.read',
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;

/**
 * Actions an acting session (`act` claim) is refused (D-5, D-15 Q-2). The coin commands come from
 * payments' own `COIN_VALUE_ACTIONS` (one list, owned by L2, not redefined here); `coins.adjust`
 * is the only coin action an acting session may use. `redemptions.resolve` is added because it
 * moves coins (release or capture) one hop away through engagement.
 */
export const ACTING_DENIED_ACTIONS: readonly Action[] = [
  ...COIN_VALUE_ACTIONS.map((a) => `coins.${a}` as const),
  'redemptions.resolve',
];

// ---- error codes ------------------------------------------------------------

export const IDENTITY_ERRORS = {
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  TENANT_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  LAUNCH_TOKEN_INVALID: 401,
  LAUNCH_TOKEN_EXPIRED: 401,
  LAUNCH_TOKEN_REPLAYED: 401,
  REALTIME_TICKET_REPLAYED: 401,
  WEBHOOK_SIGNATURE_INVALID: 401,
  TENANT_UNRESOLVED: 400,
  VALIDATION_FAILED: 400,
  ACTING_REASON_REQUIRED: 400,
  FORBIDDEN: 403,
  ACTING_REQUIRED: 403,
  ACTING_FORBIDDEN: 403,
  ACTING_TENANT_MISMATCH: 403,
  TENANT_SUSPENDED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  SLUG_TAKEN: 409,
  TENANT_PLATFORM_EXISTS: 409,
  PROVIDER_UNAVAILABLE: 503,
  INVALID_SERVICE_CREDENTIALS: 401,
  TENANT_STATUS_UNAVAILABLE: 503,
  /** D-14: a valid service token calling an internal route its client is not allowed to call. */
  SERVICE_CALL_FORBIDDEN: 403,
  /** D-11: the audit port failed, so the request is refused (fail closed). */
  AUDIT_UNAVAILABLE: 503,
} as const;
export type IdentityErrorCode = keyof typeof IDENTITY_ERRORS;

export const IdentityErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
});
export type IdentityErrorBody = z.infer<typeof IdentityErrorBody>;

// ---- tokens -----------------------------------------------------------------

/** `act` is present only on a platform_admin token minted by `acting.start`. */
export const ActingClaim = z.object({
  tenant_id: Uuid,
  reason: z.string().min(1),
});
export type ActingClaim = z.infer<typeof ActingClaim>;

/**
 * `platform_admin` exists only on the platform tenant and only alone: a token with
 * that role for another tenant, or mixed with another role, is not a claim set we
 * ever issue, so it is refused where it enters a service (the verifier). The
 * platform tenant, in turn, carries nothing but `platform_admin`.
 */
export const AccessTokenClaims = z
  .object({
    iss: z.literal(TOKEN_ISSUER),
    sub: Uuid,
    tid: Uuid,
    roles: z.array(Role).min(1),
    /**
     * One audience, or (a player session only, D-22) a non-empty array drawn from the session
     * audiences. D-23: `realtime` is never a member; only a ticket carries it, as a single string.
     */
    aud: z.union([Audience, z.array(z.enum(PLAYER_SESSION_AUDIENCES)).min(1)]),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(8),
    act: ActingClaim.optional(),
    /**
     * X-3/D-13: `true` only on a player token launched through a sandbox integration credential.
     * Absent means production. Identity sets it from the credential's `environment`; a client can
     * never add it, and producers read it from the verified auth context only.
     */
    sbx: z.literal(true).optional(),
  })
  .superRefine((c, ctx) => {
    if (Array.isArray(c.aud) && !(c.roles.length === 1 && c.roles[0] === 'player')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aud'],
        message: 'an aud array is only for a player session',
      });
    }
    const isAdmin = c.roles.includes('platform_admin');
    const onPlatform = c.tid.toLowerCase() === PLATFORM_TENANT_ID;
    const onlyAdmin = c.roles.length === 1 && c.roles[0] === 'platform_admin';
    if (isAdmin !== onPlatform || (isAdmin && !onlyAdmin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'platform_admin is bound to the platform tenant and is never combined',
      });
    }
  });
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

// ---- service-to-service tokens (coordinator decision D-4) ---------------------

export const SERVICE_NAMES = ['identity', 'engagement', 'payments'] as const;
export const ServiceName = z.enum(SERVICE_NAMES);
export type ServiceName = z.infer<typeof ServiceName>;

/**
 * A service token is minted through client credentials (`POST /v1/auth/service-token`).
 * It carries NO tenant, no roles and no `act`: `.strict()` refuses any extra claim.
 * Internal endpoints (`/internal/v1/...`) accept only this token, with the right `aud`,
 * and take `tenant_id` from the path or the body.
 */
export const ServiceTokenClaims = z
  .object({
    iss: z.literal(TOKEN_ISSUER),
    sub: z.string().regex(/^svc:(identity|engagement|payments)$/),
    aud: ServiceName,
    scope: z.literal(SERVICE_TOKEN_SCOPE),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(8),
  })
  .strict();
export type ServiceTokenClaims = z.infer<typeof ServiceTokenClaims>;

export const ServiceTokenRequest = z
  .object({
    client_id: ServiceName,
    client_secret: z.string().min(16).max(200),
    audience: ServiceName,
  })
  .strict();
export type ServiceTokenRequest = z.infer<typeof ServiceTokenRequest>;

/** Internal endpoints that identity serves (service token with aud=identity). */
export const INTERNAL_ROUTES = {
  /** `GET`, tenant in the path; the verifier's cached tenant_status reads it. */
  tenantStatus: '/internal/v1/tenants/:tenantId/status',
  /** `POST`, tenant in the path. */
  resolvePlayer: '/internal/v1/tenants/:tenantId/players/resolve',
  /** `GET`, tenant in the path: the casino integration (secrets, hash key, environment) of the tenant (X-7). */
  integration: '/internal/v1/tenants/:tenantId/integration',
  /** `GET`, the only tenant-less internal route (`@InternalTenantless`): resolves a tenant slug (X-7). */
  integrationBySlug: '/internal/v1/integrations/by-slug/:slug',
  /** `GET`, tenant in the path: the casino-side id linked to an internal player; 404 after erasure (X-8). */
  playerLink: '/internal/v1/tenants/:tenantId/players/:userId/link',
  /** `POST`, tenant-less (`@InternalTenantless`: the tenant is the ticket's own `tid`): redeem a realtime ticket once (D-23). */
  realtimeTicketRedeem: '/internal/v1/realtime-tickets/redeem',
} as const;

/**
 * Internal routes that payments serves to engagement (D-1, D-9, D-14). Names are fixed here so the
 * allow-list below can pin them; L2 builds the handlers. Reserve, capture, release, refund and the
 * balance read are the whole surface: there is no credit, mint or adjust route for a service.
 */
export const PAYMENTS_INTERNAL_ROUTES = {
  reserve: 'POST /internal/v1/tenants/:tenantId/reserves',
  capture: 'POST /internal/v1/tenants/:tenantId/reserves/:reserveId/capture',
  release: 'POST /internal/v1/tenants/:tenantId/reserves/:reserveId/release',
  refund: 'POST /internal/v1/tenants/:tenantId/reserves/:reserveId/refund',
  balance: 'GET /internal/v1/tenants/:tenantId/players/:playerId/balance',
} as const;

const IDENTITY_STATUS_ROUTE = `GET ${INTERNAL_ROUTES.tenantStatus}`;

/** Per calling client, per target audience, the allowed `METHOD route-template` entries. */
export type ServiceCallPolicy = Record<
  ServiceName,
  Partial<Record<ServiceName, readonly string[]>>
>;

/**
 * D-14: per calling client, the target audiences it may ask a token for and, per audience, the
 * internal routes it may call. The identity client registry uses it at issue time (an audience
 * outside the list is 401 INVALID_SERVICE_CREDENTIALS); the service-kit entry point of the CALLEE
 * checks it on every internal request (a route outside the list is 403 SERVICE_CALL_FORBIDDEN).
 * A service token still carries no tenant; `tenant_id` is trusted only on these routes.
 */
export const SERVICE_CALL_POLICY: ServiceCallPolicy = {
  identity: {},
  engagement: {
    identity: [
      IDENTITY_STATUS_ROUTE,
      `POST ${INTERNAL_ROUTES.resolvePlayer}`,
      `GET ${INTERNAL_ROUTES.integration}`,
      `GET ${INTERNAL_ROUTES.integrationBySlug}`,
      `GET ${INTERNAL_ROUTES.playerLink}`,
      `POST ${INTERNAL_ROUTES.realtimeTicketRedeem}`,
    ],
    payments: [
      PAYMENTS_INTERNAL_ROUTES.reserve,
      PAYMENTS_INTERNAL_ROUTES.capture,
      PAYMENTS_INTERNAL_ROUTES.release,
      PAYMENTS_INTERNAL_ROUTES.refund,
      PAYMENTS_INTERNAL_ROUTES.balance,
    ],
  },
  payments: { identity: [IDENTITY_STATUS_ROUTE] },
};

export const TenantStatusResponse = z.object({ tenant_id: Uuid, status: TenantStatus });
export type TenantStatusResponse = z.infer<typeof TenantStatusResponse>;

export const InternalResolvePlayerRequest = z
  .object({
    platform: z.string().trim().min(1).max(64),
    external_player_id: z.string().trim().min(1).max(128),
  })
  .strict();
export type InternalResolvePlayerRequest = z.infer<typeof InternalResolvePlayerRequest>;

export const InternalResolvePlayerResponse = z.object({ user_id: Uuid, created: z.boolean() });
export type InternalResolvePlayerResponse = z.infer<typeof InternalResolvePlayerResponse>;

/** X-3: an integration credential is either a sandbox or a production one; never both, never a client flag. */
export const INTEGRATION_ENVIRONMENTS = ['production', 'sandbox'] as const;
export const IntegrationEnvironment = z.enum(INTEGRATION_ENVIRONMENTS);
export type IntegrationEnvironment = z.infer<typeof IntegrationEnvironment>;

/**
 * X-7: what engagement needs to verify a casino-native webhook and to call the casino back (D-15 Q-1).
 * Served only to `svc:engagement`. Secrets are in the response, so it is never cached beyond the
 * process and never logged. `webhook_secrets` holds 1 or 2 entries (current plus one retiring key).
 */
export const TenantIntegration = z
  .object({
    tenant_id: Uuid,
    platform: z.string().min(1),
    status: TenantStatus,
    environment: IntegrationEnvironment,
    webhook_secrets: z.array(z.string().min(1)).min(1).max(2),
    /**
     * F5: the tenant's live SANDBOX credentials, served beside the production set that
     * `webhook_secrets` holds (`environment: 'production'`). Issuing a sandbox credential never cuts
     * off production webhooks, and a webhook that verifies with one of these is a sandbox deposit.
     */
    sandbox: z
      .object({ webhook_secrets: z.array(z.string().min(1)).min(1).max(2) })
      .strict()
      .optional(),
    /** Per-tenant HMAC key for hashing the casino's external player id (D-12). */
    player_hash_key: z.string().min(16),
    /** The ingest epic's `CasinoRewardApiConfig` (prod and sandbox endpoints, issue deadline); defined once, there. */
    reward_api: CasinoRewardApiConfig.optional(),
  })
  .strict();
export type TenantIntegration = z.infer<typeof TenantIntegration>;

/** X-8: the reverse of `resolvePlayer`. 404 `NOT_FOUND` after an erasure deleted the link. */
export const PlayerLinkResponse = z
  .object({ platform: z.string().min(1), external_player_id: z.string().min(1) })
  .strict();
export type PlayerLinkResponse = z.infer<typeof PlayerLinkResponse>;

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(ACCESS_TTL_MAX_SECONDS),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const JwksResponse = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal('RSA'),
        kid: z.string(),
        alg: z.literal('RS256'),
        use: z.literal('sig'),
        n: z.string(),
        e: z.string(),
      }),
    )
    .min(1),
});
export type JwksResponse = z.infer<typeof JwksResponse>;

// ---- HTTP DTOs ---------------------------------------------------------------

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(10).max(200);

export const OperatorSignupRequest = z
  .object({
    tenant_name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    email: Email,
    password: Password,
  })
  .strict();
export type OperatorSignupRequest = z.infer<typeof OperatorSignupRequest>;

/** The tenant is NOT in this body: it comes from the Host (MIO-031). `.strict()` rejects a smuggled `tenant_id`. */
export const LoginRequest = z
  .object({
    email: Email,
    password: z.string().min(1).max(200),
    audience: RequestedAudience.default('web'),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LaunchRequest = z
  .object({
    token: z.string().min(20).max(4096),
    audience: RequestedAudience.default('engagement'),
  })
  .strict();
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const StartActingRequest = z
  .object({
    tenant_id: Uuid,
    /** D-15 Q-4: minimum 8, maximum 500, enforced here; the web epic follows. */
    reason: z.string().trim().min(8).max(500),
    /** The service the acting token is for (a token is valid for one audience); identity by default. */
    audience: RequestedAudience.default('identity'),
  })
  .strict();
export type StartActingRequest = z.infer<typeof StartActingRequest>;

/** F6/F12/D-30: the platform and the environment are both required; there is no production default. */
export const IssueCredentialRequest = z
  .object({
    platform: z.string().trim().min(1).max(64),
    environment: IntegrationEnvironment,
  })
  .strict();
export type IssueCredentialRequest = z.infer<typeof IssueCredentialRequest>;

/**
 * D-27: `PUT /v1/operator/integrations/:casino/reward-api`. The operator registers where MIO calls
 * the casino to issue a reward, and the secret MIO signs those calls with, for ONE environment. The
 * sandbox endpoint is served only beside a production one (engagement never falls back to either).
 */
export const CasinoParam = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const PutRewardApiRequest = z
  .object({
    environment: IntegrationEnvironment,
    base_url: z
      .string()
      .url()
      .max(2048)
      .refine((u) => /^https?:\/\//i.test(u), { message: 'base_url must be http or https' }),
    /** The secret that signs issuance requests; sealed at rest, never returned. */
    api_key: z.string().min(1).max(512).optional(),
    /** Overrides the adapter type's default deadline; production only. */
    issue_deadline_ms: IssueDeadlineMs.optional(),
  })
  .strict();
export type PutRewardApiRequest = z.infer<typeof PutRewardApiRequest>;

/** What the PUT answers: the secret is only reported as present, never returned. */
export const RewardApiSummary = z
  .object({
    platform: z.string(),
    environment: IntegrationEnvironment,
    base_url: z.string(),
    has_api_key: z.boolean(),
    issue_deadline_ms: IssueDeadlineMs.nullable(),
  })
  .strict();
export type RewardApiSummary = z.infer<typeof RewardApiSummary>;

export const RotateRequest = z
  .object({
    grace_seconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 3600)
      .default(0),
  })
  .strict();
export type RotateRequest = z.infer<typeof RotateRequest>;

/** D-10, D-22: `POST /v1/auth/realtime-ticket` takes an empty body and answers with this. */
export const RealtimeTicketRequest = z.object({}).strict();
export type RealtimeTicketRequest = z.infer<typeof RealtimeTicketRequest>;
export const RealtimeTicketResponse = z
  .object({
    ticket: z.string().min(1),
    expires_in: z.number().int().positive().max(REALTIME_TICKET_TTL_SECONDS),
  })
  .strict();
export type RealtimeTicketResponse = z.infer<typeof RealtimeTicketResponse>;

/** D-23: the body of the internal redeem route is the ticket alone (the tenant is the ticket's own `tid`). */
export const RealtimeTicketRedeemRequest = z.object({ ticket: z.string().min(1) }).strict();
export type RealtimeTicketRedeemRequest = z.infer<typeof RealtimeTicketRedeemRequest>;

/** What `SessionsService.redeemRealtimeTicket` returns: the principal of a ticket, once (D-23). */
export const RealtimeTicketRedeemResponse = z
  .object({
    sub: Uuid,
    tid: Uuid,
    roles: z.array(Role).min(1),
    /** D-30, F8: the environment of the launch token the ticket came from; realtime is per environment. */
    sandbox: z.boolean(),
  })
  .strict();
export type RealtimeTicketRedeemResponse = z.infer<typeof RealtimeTicketRedeemResponse>;

export const InviteStaffRequest = z
  .object({ email: Email, password: Password, role: z.enum(['operator_admin', 'operator_staff']) })
  .strict();
export type InviteStaffRequest = z.infer<typeof InviteStaffRequest>;

/**
 * One row of the operator's audit view. Rows written by identity's `authorize` carry an `Action`
 * and no request fields. Rows written from `audit.acting_request` (action `acting.request`) and
 * `audit.service_call` (action `service.call`) events carry `service`, `route`, `decision`; a
 * service-call row has no user actor and no acting tenant (D-11, D-14).
 */
export const AUDIT_EVENT_ACTIONS = ['acting.request', 'service.call'] as const;
export const AuditEntry = z.object({
  id: Uuid,
  occurred_at: z.string().datetime(),
  actor_user_id: Uuid.nullable(),
  actor_tenant_id: Uuid.nullable(),
  acting_tenant_id: Uuid.nullable(),
  action: z.union([Action, z.enum(AUDIT_EVENT_ACTIONS)]),
  reason: z.string(),
  service: ServiceName.nullable().optional(),
  route: z.string().nullable().optional(),
  decision: z.enum(['allowed', 'refused', 'aborted']).nullable().optional(),
  caller_service: ServiceName.nullable().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const PlayerLookup = z.object({
  user_id: Uuid,
  platform: z.string(),
  external_player_id: z.string(),
});
export type PlayerLookup = z.infer<typeof PlayerLookup>;

export const CredentialIssued = z.object({
  key_id: z.string(),
  api_key: z.string(),
  hmac_secret: z.string(),
});
export type CredentialIssued = z.infer<typeof CredentialIssued>;

// ---- HTTP response DTOs (L5 and L3 build against these) -----------------------

export const TenantView = z.object({
  id: Uuid,
  type: TenantType,
  name: z.string(),
  slug: z.string(),
  status: TenantStatus,
});
export type TenantView = z.infer<typeof TenantView>;

export const StaffMember = z.object({
  id: Uuid,
  email: z.string().email(),
  roles: z.array(z.enum(['operator_admin', 'operator_staff'])).min(1),
});
export type StaffMember = z.infer<typeof StaffMember>;

export const SignupResponse = z.object({ tenant: TenantView, user: StaffMember });
export type SignupResponse = z.infer<typeof SignupResponse>;

/** A launch exchange answers with a player session: the token plus who and where. */
export const LaunchResponse = TokenResponse.extend({ user_id: Uuid, tenant_id: Uuid });
export type LaunchResponse = z.infer<typeof LaunchResponse>;

/** Credential list item: never the key or the secret, those are shown once at issue. */
export const CredentialSummary = z
  .object({
    key_id: z.string(),
    platform: z.string(),
    /** F6: an operator tells its sandbox keys from its production keys by this. */
    environment: IntegrationEnvironment,
    status: z.enum(['active', 'retiring', 'revoked']),
    created_at: z.string().datetime(),
  })
  .strict();
export type CredentialSummary = z.infer<typeof CredentialSummary>;
