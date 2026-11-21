# Spec: identity, tenancy and admission (feature spec)

Status: Stage A (spec and red tests, no implementation). Base: `foundation` (2d8e1f3). Implementation is Stage B and must not edit the
frozen tests listed in section 4. Backlog: MIO-030, 031, 032 (identity part), 034, 040, 042, 043, 044, 045.
Contracts: `packages/contracts/src/identity.ts` (zod schemas, constants, error codes).

## 1. Behaviour

Identity is one service: tenants module, staff accounts, our own tokens, RBAC, player identity mapping, launch-token
exchange, integration credentials. All other services only verify our tokens.

1. **Tenants.** One `platform` tenant, seeded and unique. An `operator` tenant is created by operator signup. Status is
   `active` or `suspended`. A tenant row and its `identity.tenant.created` outbox event commit in one transaction.
   A request's tenant is resolved from the `Host` (subdomain `<slug>.<BASE_DOMAIN>` or a registered domain) only at
   login; after that it is pinned in the token's `tid`. No default tenant exists: an unknown host is 400.
2. **Staff accounts.** Keyed `(tenant_id, user_id)`; `user_id` is our UUIDv7. Email is unique per tenant
   (case-insensitive); the same email in another tenant is a different account. Passwords live in the provider only.
   Roles live in our database (`user_roles`) and never come from provider claims.
3. **IdentityProvider port** (`apps/identity/src/services/identity-provider.ts`): `createTenant`, `createUser`,
   `verifyCredentials`, `exchangeLaunchToken`, `revokeSessions`, `deleteUser`. Adapters: `firebase-emulator` (default in
   compose, demo project `demo-ex-mio`), `fake` (in-memory, tests). Provider types never leave the identity service.
   A provider call that fails during signup is `PROVIDER_UNAVAILABLE` (503) and leaves no tenant and no user.
4. **Our JWT.** RS256, `iss=ex-mio-identity`, claims `sub` (user_id), `tid`, `roles`, `aud` (one service), `iat`, `exp`
   (TTL at most 900 s), `jti`, optional `act`. Public keys at `GET /.well-known/jwks.json`. Every service verifies with
   `createTokenVerifier` (service-kit) and caches the key set. Rotation: a new key signs, the previous key stays in the
   JWKS until retired.
5. **Tenant from the verified claim only.** `TenantGuard` takes the tenant from `jwtTenantResolver(verify)`:
   `act.tenant_id` if present, else `tid`. The foundation's `x-tenant-id` / `x-principal-id` placeholders, `TENANT_HEADER`,
   `PRINCIPAL_HEADER` and `headerTenantResolver` are removed. A missing, forged, expired or wrong-audience token is 401.
6. **RBAC.** `AccessService.can(subject, action, object)` (pure) and `authorize(...)` (throws, writes the acting audit).
   Roles: `platform_admin`, `operator_admin`, `operator_staff`, `player`. Default deny. Every controller route declares
   `@RequirePermission(action)` or `@Public()`; `PermissionGuard` denies a route with neither.
7. **Acting.** A `platform_admin` calls `POST /v1/auth/acting` with `{tenant_id, reason}` and gets a token (TTL at most
   900 s) with `tid` = platform tenant, `roles` = `[platform_admin]`, `act = {tenant_id, reason}`. While acting, requests
   run in the acting tenant, every `authorize` writes one audit row naming the real actor and the acting tenant, coin
   commands that move value are denied (except `coins.adjust`), and a new acting session cannot be started.
8. **Player identity.** `player_links (tenant_id, platform, external_player_id) -> user_id`, one writer
   (`PlayersService.resolveOrCreate`, idempotent, concurrency-safe). A player user has role `player` and no password.
9. **Launch token.** Casino-signed HS256 JWT, header `kid` = integration key id, claims `pid`, `plat`, `aud=mio-launch`,
   `iat`, `exp` (lifetime at most 300 s, `iat` at most 60 s in the future), `jti`. Verified before any provider call,
   `jti` recorded single-use only after the signature verified, tenant taken from the key. Result: a player session JWT.
10. **Integration credentials.** Per tenant and platform: `key_id`, `api_key`, `hmac_secret`. The secret and key are
    shown once. At rest the api key is hashed and the secret encrypted (`CREDENTIALS_KEK`). Webhook scheme:
    headers `x-mio-key`, `x-mio-timestamp`, `x-mio-signature` = hex HMAC-SHA256 over `${timestamp}.${rawBody}`, skew at
    most 300 s. The tenant of a webhook is the tenant of its key. Rotation: new key; old key stops now or after
    `graceSeconds`.

## 2. State tables

Tenant status: `active` <-> `suspended` (by `platform_admin` only). Suspended: login, launch exchange and acting-less
token issue are refused with `TENANT_SUSPENDED`; verification of already issued tokens is unchanged (they expire in at
most 900 s). Acting on a suspended tenant is allowed (support).

Launch token: `received -> (verify signature, kid, alg, aud, exp, iat, lifetime, pid) -> tenant active -> jti recorded
-> link resolved -> provider call -> session issued`. Any failing step before "jti recorded" leaves no trace.

Credential: `active -> retiring (until grace ends) -> revoked`. Rotation makes the old key `retiring` (grace > 0) or
`revoked` (grace = 0) in the same transaction that creates the new `active` key.

Access token life: `issued -> valid -> expired (exp) | key retired (JWKS no longer lists kid)`.

## 3. Roles and actions (the permission matrix is pinned by `INV-RBAC-1`)

| action                                                         | operator_admin | operator_staff                 | player             | platform_admin                |
| -------------------------------------------------------------- | -------------- | ------------------------------ | ------------------ | ----------------------------- |
| staff.invite, credentials.read, credentials.rotate, audit.read | yes            | no                             | no                 | only acting                   |
| staff.list, players.read                                       | yes            | yes (players.read, staff.list) | no                 | only acting                   |
| player.self.read                                               | no             | no                             | own `user_id` only | no                            |
| tenant.read                                                    | own tenant     | no                             | no                 | platform tenant, or acting    |
| tenant.suspend                                                 | no             | no                             | no                 | yes                           |
| acting.start                                                   | no             | no                             | no                 | yes (not when already acting) |
| coins.credit, hold, capture, release, refund                   | no             | no                             | no                 | never while acting            |
| coins.adjust                                                   | admin          | no                             | no                 | acting, audited               |

`authorize` outcomes: other tenant's object -> `NOT_FOUND` (404); same tenant but another player's object -> `NOT_FOUND`;
same tenant, role too weak -> `FORBIDDEN` (403); platform_admin without acting on an operator object ->
`ACTING_REQUIRED` (403); acting for A on an object of B -> `ACTING_TENANT_MISMATCH` (403); acting subject on a value coin
command -> `ACTING_FORBIDDEN` (403).

## 4. Invariants, choke points, tests

"Mutation" is the change that must turn the named test red. The same text is in each test's header comment.

| Invariant                                                                                                                                                           | Backlog AC                                                       | Choke point (where a bad value cannot be built)                       | Frozen test                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| INV-TOK-1..8 every service trusts only tokens our key signed (signature, alg allow-list, aud, exp, TTL cap, claim schema, rotation, `act` only with platform_admin) | MIO-042 AC1-4, MIO-034 AC forged acting                          | `createTokenVerifier` in `packages/service-kit/src/auth.ts`           | `packages/service-kit/src/auth.test.ts`                               |
| INV-TENANT-1..4 tenant only from the verified claim; header placeholder gone; acting tenant served                                                                  | MIO-031 AC1, MIO-034                                             | `TenantGuard` + `jwtTenantResolver` in `packages/tenancy/src/nest.ts` | `packages/service-kit/src/auth.test.ts`                               |
| INV-TEN-1..6 tenant registry (one platform, operator signup, outbox atomicity, slug unique, host resolution, suspended)                                             | MIO-030 AC1,3; MIO-031 AC2                                       | `TenantsService` + tenants repository                                 | `apps/identity/src/identity.tenants.test.ts`                          |
| INV-STAFF-1..8 `(tenant_id, user_id)`, email unique per tenant, DB roles, provider failure, no provider ids in tokens                                               | MIO-043 AC1,2; MIO-040                                           | `StaffService`, `SessionsService.login`                               | `apps/identity/src/identity.staff.test.ts`                            |
| INV-JWT-1..5 issued token shape, JWKS public-only, TTL, rotation, claim validity                                                                                    | MIO-042                                                          | `SessionsService`                                                     | `apps/identity/src/identity.tokens.test.ts`                           |
| INV-ACT-1..6 acting sessions                                                                                                                                        | MIO-034 AC and negative cases                                    | `SessionsService.startActing`                                         | `apps/identity/src/identity.tokens.test.ts`                           |
| INV-RBAC-1..5 can() matrix, default deny, no null-tenant shortcut                                                                                                   | MIO-045                                                          | `AccessService.can`                                                   | `apps/identity/src/identity.access.test.ts`                           |
| INV-OWN-1..3 404 versus 403                                                                                                                                         | MIO-045 AC3, cross-tenant 404, MIO-154 same-tenant player A vs B | `AccessService.authorize`                                             | `apps/identity/src/identity.access.test.ts`                           |
| INV-ACTAUTH-1..7 acting audited, only way across, coin deny                                                                                                         | MIO-034                                                          | `AccessService.authorize`, `SessionsService.startActing`              | `apps/identity/src/identity.access.test.ts`                           |
| INV-LAUNCH-1..9 launch token admission                                                                                                                              | MIO-044 all rejection cases, replay, tenant from key             | `LaunchService.exchange`                                              | `apps/identity/src/identity.launch.test.ts`                           |
| INV-PLAYER-1..6 one link per triple, concurrency, deposit-then-launch, reader                                                                                       | MIO-044                                                          | `PlayersService.resolveOrCreate`, `lookup`                            | `apps/identity/src/identity.launch.test.ts`                           |
| INV-CRED-1..6 credentials, webhook tenant from key, rotation                                                                                                        | MIO-031 webhooks, MIO-044                                        | `CredentialsService`                                                  | `apps/identity/src/identity.credentials.test.ts`                      |
| INV-EDGE-1..11 HTTP edge (header ignored, forged token, host resolution, validation, 404, acting over HTTP)                                                         | MIO-031, MIO-034, MIO-045                                        | guards + controllers                                                  | `apps/identity/src/identity.http.test.ts`                             |
| INV-PERM-1..2 every route declares a permission; undeclared is denied                                                                                               | MIO-045 AC1                                                      | `PermissionGuard`, route walk                                         | `apps/identity/src/identity.http.test.ts`                             |
| INV-DB-1..7 schema enforces uniqueness, RLS, composite FK                                                                                                           | MIO-030 AC1,2; MIO-032; MIO-044                                  | migration                                                             | `tests/compose/src/identity.compose.test.ts`                          |
| INV-STACK-1..3 JWKS public, header placeholder refused by every service, audience separation                                                                        | MIO-042 AC1,2                                                    | service-kit bootstrap                                                 | `tests/compose/src/identity.compose.test.ts`                          |
| Contract shapes                                                                                                                                                     | n/a                                                              | zod schemas                                                           | `packages/contracts/src/identity.contracts.test.ts` (green by design) |

Reader tests (a stored record is consumed and described correctly): INV-ACTAUTH-3 and INV-EDGE-8 (audit read back by the
operator), INV-PLAYER-3 and INV-PLAYER-4 (link written by deposit is the one launch resolves; operator lookup).

## 5. API contracts

Public (no token): `POST /v1/operators/signup` (201), `POST /v1/auth/login` (tenant from `Host`), `POST /v1/auth/launch`,
`GET /.well-known/jwks.json`, `GET /healthz/*`. Webhook signature verification is a service method
(`CredentialsService.verifyWebhook`); the engagement service calls it through identity's internal API (out of scope here).

Protected (bearer, audience `identity`): `POST /v1/auth/acting` (`acting.start`), `POST /v1/staff` (`staff.invite`),
`GET /v1/staff` (`staff.list`), `GET /v1/players/:userId` (`players.read`), `GET /v1/tenants/:id` (`tenant.read`),
`POST /v1/tenants/:id/suspend` (`tenant.suspend`), `GET /v1/credentials` (`credentials.read`),
`POST /v1/credentials/:keyId/rotate` (`credentials.rotate`), `POST /v1/credentials` (`credentials.rotate`),
`GET /v1/audit` (`audit.read`). Bodies and responses are the schemas in `packages/contracts/src/identity.ts`.
Error body: `{code, message, issues?}` (`IdentityErrorBody`).

Events: `identity.tenant.created` v1 (existing). No new event type in this spec.

Removed: `PlatformAdminGuard`, `PLATFORM_ADMIN_TOKEN`, `HEADER_PLATFORM_TOKEN`, the `x-tenant-id` / `x-principal-id`
headers. The foundation tests that pin them (`apps/identity/src/tenants.test.ts`, the header cases in
`packages/tenancy/src/tenancy.test.ts`, `tests/compose/src/tenancy.compose.test.ts`, `PLATFORM_TOKEN` in
`tests/compose/src/env.ts`) are not frozen: Stage B rewrites them for token auth. The other services must switch
from the header to the token in the same merge.

## 6. Error codes

All in `IDENTITY_ERRORS` (code -> HTTP status): TOKEN_INVALID 401, TOKEN_EXPIRED 401, TENANT_REQUIRED 401,
INVALID_CREDENTIALS 401, LAUNCH_TOKEN_INVALID 401, LAUNCH_TOKEN_EXPIRED 401, LAUNCH_TOKEN_REPLAYED 401,
WEBHOOK_SIGNATURE_INVALID 401, TENANT_UNRESOLVED 400, VALIDATION_FAILED 400, ACTING_REASON_REQUIRED 400, FORBIDDEN 403,
ACTING_REQUIRED 403, ACTING_FORBIDDEN 403, ACTING_TENANT_MISMATCH 403, TENANT_SUSPENDED 403, NOT_FOUND 404,
EMAIL_TAKEN 409, SLUG_TAKEN 409, TENANT_PLATFORM_EXISTS 409, PROVIDER_UNAVAILABLE 503. Service errors carry `code`
(a property on the thrown exception); the exception filter maps it to the status and `IdentityErrorBody`.

## 7. Surface the frozen tests import (Stage B builds exactly this)

- `packages/service-kit/src/auth.ts`: `createTokenVerifier({audience, jwks, nowSeconds?}) -> (token) => Promise<AccessTokenClaims>`,
  `TokenRejectedError {code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED'}`. Use `jose` or `node:crypto`; the allow-list is RS256 only.
- `packages/tenancy`: export `jwtTenantResolver(verify)`; `TenantResolver` may return a promise; `TenantGuard.canActivate`
  becomes async; `TenantGuard` built without a resolver denies everything but `@Public()`; delete the header exports.
  Re-export `IS_PUBLIC` (already exported).
- `apps/identity/src/controllers/index.ts`: `identityControllers: Type[]`. `controllers/permissions.ts`: `PERMISSION_KEY`,
  `RequirePermission(action)`, `PermissionGuard`.
- `apps/identity/src/services/access.service.ts`: `Subject = {userId, tenantId, roles: Role[], acting?: {tenantId, reason}}`,
  `AccessService` with `can(subject, action, {tenant_id, user_id?}): boolean` and `authorize(...): Promise<void>`.
- `apps/identity/src/testing/kernel.ts`: `buildKernel(opts?: {outboxFails?, providerDown?, providerClaims?})` wires the
  real services with in-memory repositories, `FakeIdentityProvider`, an in-memory outbox and audit, and a controllable
  clock. It returns:
  `now()` (seconds), `advance(seconds)`, `sign(claims)` (signs arbitrary claims with the current key), `verify(token,
audience)`, `subjectOf(claims)`, `tenants {platformTenant, create, setStatus, resolveByHost, listOperatorSlugs}`,
  `staff {signUpOperator, createPlatformAdmin, invite, list, listUnsafeForTest(tenantId)}`, `sessions {login, startActing,
jwks, rotateKey, retireKey}`, `access {can, authorize}`, `credentials {issue, rotate, list, verifyWebhook,
storedRowsForTest}`, `launch {exchange}`, `players {resolveOrCreate, links, lookup}`, `audit {list(tenantId)}`,
  `outbox {events()}`, `provider {calls, subjectFor(userId)}`. Signatures are as the tests call them. The kernel must
  use the same services the controllers use, not a parallel implementation.
- `apps/identity/src/testing/app.ts`: `createTestApp({extraControllers?}) -> {app, kernel}`: a Nest Fastify app with the real
  guards, controllers and filter over that kernel; `BASE_DOMAIN` is `mio.test`.
- Migration `apps/identity/src/model/migrations/<ts>-IdentityCore.ts`: tables `tenants` (adds `type`, `status`, `domains`;
  partial unique index on `type` where platform), `users (tenant_id, id, email nullable, kind)`, `user_roles`,
  `provider_links`, `player_links`, `launch_jti (tenant_id, jti, expires_at)`, `integration_credentials`, `audit_log`,
  `signing_keys` (platform table, no `tenant_id`). Tenant tables: PK `(tenant_id, id)`, composite FKs,
  `enableTenantRls`. Unique `(tenant_id, email)` where email not null; `player_links` unique on
  `(tenant_id, platform, external_player_id)` and on `(tenant_id, user_id)`. Seed the platform tenant in the migration.

## 8. Out of scope (other specs or later tasks)

Refresh tokens and family revocation (MIO-042 tail), sign-in rate limit and lockout (MIO-043 AC3), `operator.signed_up`
analytics event, tenant `trial` status, service-to-service tokens (MIO-046), per-service broker users, Cognito or
Identity Platform adapters (MIO-041), the `firebase-emulator` adapter contract suite beyond a smoke test, websocket
channel isolation (MIO-033), coin endpoints themselves (payments spec), the engagement-side cache of `user_id`.
Stage B may add the provider contract suite for `fake` and the emulator adapter, but the frozen tests above do not
depend on it.

## 9. How to run

`cd apps/identity && npx jest --maxWorkers=2`, `cd packages/service-kit && npx jest`, `cd packages/contracts && npx jest`.
Compose tests: `flock <lock> docker compose up -d --wait`, then `cd tests/compose && npx jest --runInBand identity`,
then `down -v`. Compose tests are red today for two reasons: missing tables and a missing JWKS route.
