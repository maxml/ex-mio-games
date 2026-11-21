import { z } from 'zod';
import { Uuid } from './ids';

// Identity contracts (feature spec). Spec: docs/specs/identity.md. Every service
// parses tokens with these shapes; nothing else defines what a claim means.

// ---- vocabulary ------------------------------------------------------------

export const TenantType = z.enum(['platform', 'operator']);
export type TenantType = z.infer<typeof TenantType>;

export const TenantStatus = z.enum(['active', 'suspended']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const Role = z.enum(['platform_admin', 'operator_admin', 'operator_staff', 'player']);
export type Role = z.infer<typeof Role>;

/** Service audiences a token can be minted for. A token is valid for exactly one. */
export const SERVICE_AUDIENCES = ['identity', 'engagement', 'payments', 'web'] as const;
export const Audience = z.enum(SERVICE_AUDIENCES);
export type Audience = z.infer<typeof Audience>;

export const TOKEN_ISSUER = 'ex-mio-identity';
export const ACCESS_TTL_MAX_SECONDS = 900;
export const ACTING_TTL_MAX_SECONDS = 900;
export const LAUNCH_TOKEN_MAX_TTL_SECONDS = 300;
export const LAUNCH_TOKEN_CLOCK_SKEW_SECONDS = 60;
export const LAUNCH_TOKEN_AUDIENCE = 'mio-launch';
export const LAUNCH_TOKEN_ALGS = ['HS256'] as const;
export const WEBHOOK_MAX_SKEW_SECONDS = 300;
export const ACCESS_TOKEN_ALGS = ['RS256'] as const;

export const HEADER_WEBHOOK_KEY = 'x-mio-key';
export const HEADER_WEBHOOK_TIMESTAMP = 'x-mio-timestamp';
export const HEADER_WEBHOOK_SIGNATURE = 'x-mio-signature';

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
  'coins.hold',
  'coins.capture',
  'coins.release',
  'coins.refund',
  'coins.adjust',
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;

/** Coin commands that move value. An acting session may call only `coins.adjust`. */
export const COIN_VALUE_ACTIONS: readonly Action[] = [
  'coins.credit',
  'coins.hold',
  'coins.capture',
  'coins.release',
  'coins.refund',
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

export const AccessTokenClaims = z.object({
  iss: z.literal(TOKEN_ISSUER),
  sub: Uuid,
  tid: Uuid,
  roles: z.array(Role).min(1),
  aud: Audience,
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8),
  act: ActingClaim.optional(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

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
  .object({ email: Email, password: z.string().min(1).max(200), audience: Audience.default('web') })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LaunchRequest = z
  .object({ token: z.string().min(20).max(4096), audience: Audience.default('engagement') })
  .strict();
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const StartActingRequest = z
  .object({ tenant_id: Uuid, reason: z.string().trim().min(1).max(500) })
  .strict();
export type StartActingRequest = z.infer<typeof StartActingRequest>;

export const InviteStaffRequest = z
  .object({ email: Email, password: Password, role: z.enum(['operator_admin', 'operator_staff']) })
  .strict();
export type InviteStaffRequest = z.infer<typeof InviteStaffRequest>;

export const AuditEntry = z.object({
  id: Uuid,
  occurred_at: z.string().datetime(),
  actor_user_id: Uuid,
  actor_tenant_id: Uuid,
  acting_tenant_id: Uuid,
  action: Action,
  reason: z.string(),
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
