# Spec: identity, tenancy and admission (feature spec)

Status: Stage A (spec and red tests, no implementation). Base: `foundation` (2d8e1f3). Implementation is Stage B and must not edit the
frozen tests listed in section 4. Backlog: MIO-030, 031, 032 (identity part), 034, 040, 042, 043, 044, 045, 046 (service-to-service,
taken by this epic, coordinator decision D-4).
Contracts: `packages/contracts/src/identity.ts` (zod schemas, constants, error codes).
Binding decisions applied here: D-4 (service tokens, one auth entry point), D-5 (acting never moves coins, enforced in payments),
D-6 (cached tenant status, 15-minute access TTL without refresh tokens, 30 s skew), D-7 (Firebase emulator multi-tenancy),
D-11 (every acting request is audited by the entry point of every service), D-14 (per-client allow-list of audiences and internal
routes, checked by the callee; normalised-path matching; route scan for the coin guard; TTL + skew expiry probes).
Stage A review fixes F1-F16 (round 1) and N1-N9, D-11, D-14 (rounds 2 and 3) are applied; the finding to change map is in section 10.

## 1. Behaviour

Identity is one service: tenants module, staff accounts, our own tokens, RBAC, player identity mapping, launch-token
exchange, integration credentials. All other services only verify our tokens.

1. **Tenants.** One `platform` tenant, seeded and unique, with slug `platform` (host `platform.<BASE_DOMAIN>`). Identity seeds one
   platform admin at boot from `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` (idempotent; dev defaults in compose and
   `.env.example`, used by INV-STACK-8). An `operator` tenant is created by operator signup. Status is
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
   **Per-tenant email (D-7).** The `firebase-emulator` adapter uses the emulator's multi-tenancy: one Identity Platform
   tenant per MIO tenant, created by `createTenant` when the MIO tenant is created. The same email therefore registers in two
   tenants as two accounts with their own passwords. Pinned by `INV-STACK-7` (compose, under the lock).
4. **Our JWT.** RS256, `iss=ex-mio-identity`, claims `sub` (user_id), `tid`, `roles`, `aud` (one service), `iat`, `exp`
   (TTL at most 900 s), `jti`, optional `act`, optional `nbf`. A `kid` header is required. Public keys at
   `GET /.well-known/jwks.json`. Every service verifies with `createTokenVerifier` (service-kit). Rotation: a new key signs,
   the previous key stays in the JWKS until retired.
   - **JWKS cache policy (numbers, `contracts`).** The key set is cached for `JWKS_CACHE_TTL_SECONDS` = 300 s. A token whose
     `kid` is not in the cache triggers one refetch, at most once per `JWKS_REFETCH_MIN_INTERVAL_SECONDS` = 30 s, so a stream
     of random `kid`s cannot force a fetch per request. A fetch failure fails closed (`TOKEN_INVALID`); there is no
     stale-if-error. A removed key therefore stops verifying at most 300 s after removal.
   - **Clock skew (D-6, Q3).** `exp`, `nbf` and `iat` are compared with `ACCESS_TOKEN_CLOCK_SKEW_SECONDS` = 30 s of leeway.
     The TTL cap (`exp - iat <= 900`) has no leeway. Consequence, pinned by every expiry test: a 900 s token is still valid
     at +929 s and is `TOKEN_EXPIRED` at +931 s (INV-JWT-4, INV-ACT-5, INV-EDGE-11, INV-AUTH-3, N1). No test may expect expiry
     at +901 s.
   - **Platform binding (F8).** The claim schema refuses `platform_admin` on any `tid` other than `PLATFORM_TENANT_ID`
     (`00000000-0000-7000-8000-000000000001`, seeded by the migration), refuses it mixed with any other role, and refuses any
     other role on the platform tenant. This is enforced in the verifier, so it holds in every service.
   - **TTL and refresh (D-6, Q2).** Access TTL is 900 s. Refresh tokens and family revocation are deferred for the
     submission; the README lists them under "next".
5. **Tenant from the verified claim only, through ONE entry point (D-4, F2).** Every service (identity, engagement,
   payments) is wired with `ServiceAuthModule.forService({ audience, identityUrl })` from service-kit and nothing else.
   It builds the verifier, the deny-by-default guard and the tenant context. It has **no resolver option**: unknown options
   (including `resolver`), a missing or non-service `audience`, and a missing tenant status source all throw at boot.
   `TenancyModule` is removed from `packages/tenancy`; `TenantGuard`, `TenantInterceptor` and `jwtTenantResolver` stay as
   building blocks of the entry point and are not wired by apps. The tenant is `act.tenant_id` if present, else `tid`. The
   foundation's `x-tenant-id` / `x-principal-id` / `x-platform-admin-token` headers and their constants are deleted; a source
   scan (`INV-SCAN`) fails on any leftover. A missing, forged, expired or wrong-audience token is 401.
   - **Tenant status (D-6, Q1).** For user tokens the entry point checks the tenant's status through a cached lookup
     (`GET /internal/v1/tenants/:tenantId/status` on identity, service token), cached `TENANT_STATUS_CACHE_SECONDS` = 30 s per
     tenant. A suspended tenant's tokens get 403 `TENANT_SUSPENDED` within 30 s. An unreachable lookup fails closed
     (503 `TENANT_STATUS_UNAVAILABLE`). Acting sessions are exempt (support on a suspended tenant is allowed, section 2);
     internal calls are exempt.
   - **Audit port (D-11, D-14).** The entry point writes an event for (a) every request that carries a verified `act` claim,
     `audit.acting_request` v1 (envelope tenant = the acting tenant; `route` is `METHOD template`, never the raw URL or the query),
     and (b) every internal request, `audit.service_call` v1 (envelope tenant = the tenant of the call). One event per request,
     allowed or refused, also when a later guard refuses and when a handler or filter errors; none for ordinary user tokens or
     for tokens that failed verification (unverified claims are never written as an actor). The port is
     `auditPort(event) => Promise<void>`; with `identityUrl` it defaults to the service's own outbox, otherwise it is required.
     **Fail closed (decision on Q-B):** if the port throws, the request is `503 AUDIT_UNAVAILABLE` and the handler does not run.
     Identity consumes both event types into `audit_log` (one row per event id, idempotent). The request-level rows
     (`acting.request`, `service.call`) and identity's permission-level rows (`authorize`, section 1.7) are both kept and are
     told apart by `action` (N9).
   - **Auth context.** Inside a handler `currentAuth()` (service-kit) returns
     `{mode: 'user'|'service', tenantId?, principalId, roles, acting?: {tenantId, reason}, service?}`. A guard that runs after the
     entry point reads the same data with `authOf(request)`. This is how payments sees the `acting` claim.
6. **RBAC.** `AccessService.can(subject, action, object)` (pure) and `authorize(...)` (throws, writes the acting audit).
   Roles: `platform_admin`, `operator_admin`, `operator_staff`, `player`. Default deny. Every controller route declares
   `@RequirePermission(action)` or `@Public()`; `PermissionGuard` denies a route with neither. Routes under `/internal/v1/`
   are service-token routes and have no user permission. `can()` answers `false` for a `platform_admin` subject whose
   `tenantId` is not `PLATFORM_TENANT_ID`.
7. **Acting.** A `platform_admin` calls `POST /v1/auth/acting` with `{tenant_id, reason, audience?}` (`audience` is the service
   the token is for, `identity` by default, so an acting token can be presented to engagement or payments) and gets a token (TTL at most
   900 s) with `tid` = `PLATFORM_TENANT_ID`, `roles` = `[platform_admin]`, `act = {tenant_id, reason}`. While acting, requests
   run in the acting tenant, every identity `authorize` writes one audit row naming the real actor and the acting tenant,
   coin commands that move value are denied (except `coins.adjust`), and a new acting session cannot be started.
   - **Coins are refused where they happen (D-5, F3).** Payments owns every coin operation, so payments refuses them:
     `ActingCoinGuard` (payments, `controllers/coin-action.ts`) reads `acting` from the service-kit auth context and answers
     403 `ACTING_FORBIDDEN` for the five value actions `coins.credit|hold|capture|release|refund`, before the handler runs.
     Every payments controller carries `@UseGuards(ActingCoinGuard)` (a controller-level guard always runs after the global
     `ServiceAuthModule` guard, so ordering never depends on module registration; with no auth context it answers 401, it never
     passes) and every handler declares `@CoinAction(action)`, `@NoCoinEffect()` or `@Public()`; an undeclared handler is
     denied. The five-action list is pinned as a literal in `identity.contracts.test.ts`, `identity.access.test.ts` and
     `acting-ban.test.ts`.
   - **Audit outside identity (D-11).** The audit of acting requests is owned by this epic in the entry point (section 1.5), so
     engagement and payments add no audit code of their own. Identity's `authorize` still writes its permission-level row.
   - **A coin route is guarded everywhere, including child modules (D-14, N3).** The guard rule is checked by a scan of the
     module tree reachable from each app's `createAppModule`, not by a list: every controller found carries `ActingCoinGuard`
     and every route declares its coin effect. A controller in an imported child module is found and fails the scan.
   - **Operators never mint coins (D-14, N4).** `coins.credit` is "no" for every role (section 3) and credits come from the inbox
     (D-1). Payments answers an operator token on `POST /v1/credits` with 403 `FORBIDDEN` (pinned inverted, INV-ACTBAN-2 and
     INV-STACK-2c); the full payments RBAC matrix is L2's. Services never call a credit, mint or adjust route (1.11).
8. **Player identity.** `player_links (tenant_id, platform, external_player_id) -> user_id`, one writer
   (`PlayersService.resolveOrCreate`, idempotent, concurrency-safe). A player user has role `player` and no password.
9. **Launch token.** Casino-signed HS256 JWT, header `kid` = integration key id, claims `pid`, `plat`, `aud=mio-launch`,
   `iat`, `exp` (lifetime at most 300 s, `iat` at most 60 s in the future), `jti`. Verified before any provider call,
   `jti` recorded single-use only after the signature verified, tenant taken from the key. Result: a player session JWT.
   **The platform comes from the key too (F7).** The `plat` claim must equal the key's platform, otherwise
   `LAUNCH_TOKEN_INVALID`; the link is always written under the key's platform. The key lookup honours key status: a revoked
   key, or a retiring key past its grace, is `LAUNCH_TOKEN_INVALID` (F6), the same rule as for webhooks.
10. **Integration credentials.** Per tenant and platform: `key_id`, `api_key`, `hmac_secret`. The secret and key are
    shown once. At rest the api key is hashed and the secret encrypted (`CREDENTIALS_KEK`). Webhook scheme:
    headers `x-mio-key`, `x-mio-timestamp`, `x-mio-signature` = hex HMAC-SHA256 over `${timestamp}.${rawBody}`, skew at
    most 300 s. The tenant of a webhook is the tenant of its key. Rotation: new key; old key stops now or after
    `graceSeconds`. One lookup (`CredentialsService`) serves webhooks and launches.
11. **Service-to-service auth (D-4, MIO-046).** Each service has a client id (its name) and a secret from env. It gets a
    short-lived token from `POST /v1/auth/service-token` (`ServiceTokenRequest`: `client_id`, `client_secret`, `audience`).
    Claims (`ServiceTokenClaims`, strict): `iss`, `sub=svc:<name>`, `aud=<target service>`, `scope=internal`, `iat`, `exp`
    (at most 300 s), `jti`. **No tenant, no roles, no `act`.** `createServiceTokenVerifier` verifies it (same JWKS, cache and
    skew as user tokens); a user token never satisfies it and the reverse. Routes under `/internal/v1/` accept ONLY a service
    token with the right `aud`; they take `tenant_id` explicitly, in the path or the body, and the entry point sets the tenant
    context from it, in service mode only (never from a header, the Host or the token). The one tenant-less internal route,
    `verifyWebhook`, is declared `@InternalTenantless()`: its tenant is the tenant of the key. Events carry the tenant in the
    bus envelope. A wrong or unknown client secret is 401 `INVALID_SERVICE_CREDENTIALS`.
    **Scoping (D-14).** `SERVICE_CALL_POLICY` (contracts) lists per calling client the audiences it may ask for and per audience
    the `METHOD route-template` entries it may call. Identity refuses a token for an audience outside the list
    (401 `INVALID_SERVICE_CREDENTIALS`); the entry point of the CALLEE refuses a route outside the list (403
    `SERVICE_CALL_FORBIDDEN`, handler not run). Entries match the whole template and method, never a prefix. Today:
    engagement -> payments is exactly reserve, capture, release, refund and the balance read (`PAYMENTS_INTERNAL_ROUTES`);
    engagement -> identity is status, resolve player, verify webhook; payments -> identity is status only; identity calls
    nobody. No service holds a credit, mint or adjust route. The tenant named in the path or body is trusted only on these
    listed routes, a path tenant and a different body `tenant_id` is 400 `VALIDATION_FAILED`, and every internal call is
    audited (`audit.service_call`, 1.5). A service token still carries no tenant.
    **Normalised path (D-14, N2).** Whether a request is internal is decided on the normalised, percent-decoded path of the
    matched route, never on the raw URL string or the query: `/%69nternal/v1/...` is `/internal/v1/...`. A user token on it is
    401, a service token on it is served in service mode. `PermissionGuard` in identity uses the same decision.

## 2. State tables

Tenant status: `active` <-> `suspended` (by `platform_admin` only). Suspended: login, launch exchange and acting-less
token issue are refused with `TENANT_SUSPENDED`; already issued tokens of the tenant are refused by every service within
30 s (cached tenant status, section 1.5). Acting on a suspended tenant is allowed (support).

Launch token: `received -> (verify signature, kid, alg, aud, exp, iat, lifetime, pid) -> tenant active -> jti recorded
-> link resolved -> provider call -> session issued`. Any failing step before "jti recorded" leaves no trace.

Credential: `active -> retiring (until grace ends) -> revoked`. Rotation makes the old key `retiring` (grace > 0) or
`revoked` (grace = 0) in the same transaction that creates the new `active` key.

Access token life: `issued -> valid -> expired (exp) | key retired (JWKS no longer lists kid)`.

## 3. Roles and actions (the permission matrix is pinned by `INV-RBAC-1`)

| action                                                         | operator_admin | operator_staff                 | player             | platform_admin                                         |
| -------------------------------------------------------------- | -------------- | ------------------------------ | ------------------ | ------------------------------------------------------ |
| staff.invite, credentials.read, credentials.rotate, audit.read | yes            | no                             | no                 | only acting                                            |
| staff.list, players.read                                       | yes            | yes (players.read, staff.list) | no                 | only acting                                            |
| player.self.read                                               | no             | no                             | own `user_id` only | no                                                     |
| tenant.read                                                    | own tenant     | no                             | no                 | platform tenant, or acting                             |
| tenant.suspend                                                 | no             | no                             | no                 | yes                                                    |
| acting.start                                                   | no             | no                             | no                 | yes (not when already acting)                          |
| coins.credit, hold, capture, release, refund                   | no             | no                             | no                 | no (never; payments also refuses an acting token, D-5) |
| coins.adjust                                                   | admin          | no                             | no                 | acting, audited                                        |

`authorize` outcomes: other tenant's object -> `NOT_FOUND` (404); same tenant but another player's object -> `NOT_FOUND`;
same tenant, role too weak -> `FORBIDDEN` (403); platform_admin without acting on an operator object ->
`ACTING_REQUIRED` (403); acting for A on an object of B -> `ACTING_TENANT_MISMATCH` (403); acting subject on a value coin
command -> `ACTING_FORBIDDEN` (403).

## 4. Invariants, choke points, tests

"Mutation" is the change that must turn the named test red. The same text is in each test's header comment.

| Invariant                                                                                                                                                                                                                                                                                                | Backlog AC                                                       | Choke point (where a bad value cannot be built)                              | Frozen test                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| INV-TOK-1..10 every service trusts only tokens our key signed (signature, alg allow-list incl. PEM confusion and missing kid, aud, exp, TTL cap, claim schema, JWKS cache and rotation, `act` only with platform_admin, platform binding, 30 s skew, service tokens)                                     | MIO-042 AC1-4, MIO-034 AC forged acting                          | `createTokenVerifier` in `packages/service-kit/src/auth.ts`                  | `packages/service-kit/src/auth.test.ts`                                  |
| INV-TENANT-1..4 tenant only from the verified claim; header placeholder gone; acting tenant served                                                                                                                                                                                                       | MIO-031 AC1, MIO-034                                             | `TenantGuard` + `jwtTenantResolver` in `packages/tenancy/src/nest.ts`        | `packages/service-kit/src/auth.test.ts`                                  |
| INV-AUTH-1..10 one entry point for every service: header ignored, claim only, +929/+931 expiry window and one JWKS fetch (3), no resolver option and a required audit port (6), cached tenant status, internal routes service-token only on the normalised path with a path/body tenant check (8), every acting request audited, fail closed (9), per-client route allow-list and `audit.service_call` (10) | MIO-031 AC1, MIO-046, D-4, D-6, D-11, D-14                       | `ServiceAuthModule.forService` in `packages/service-kit/src/service-auth.ts` | `packages/service-kit/src/service-auth.test.ts`                          |
| INV-SCAN-1..4 no header-based tenant code, no app-level tenancy wiring, no leftover foundation test or deploy secret                                                                                                                                                                                     | D-4, F2, F15                                                     | the repository (source scan)                                                 | `packages/service-kit/src/no-header-tenant.test.ts`                      |
| INV-WIRE-1..4 payments and engagement are wired through the entry point (audience, identity URL, no tenancy module, acting guard over the whole module tree, no audit or allow-list override)                                                                                                           | F2, D-11, D-14                                                   | `createAppModule` of each app                                                | `apps/payments/src/wiring.test.ts`, `apps/engagement/src/wiring.test.ts` |
| INV-ACTBAN-1..9 payments refuses coin value actions to an acting token; services (not operators) run the value actions; every handler of every controller in the module tree declares its coin effect (scan, child modules included); the guard fails closed without the entry point; the refusal is audited | MIO-034, D-5, F3, D-14                                           | `ActingCoinGuard` in `apps/payments/src/controllers/coin-action.ts`          | `apps/payments/src/acting-ban.test.ts`                                   |
| INV-S2S-1..9 client-credentials tokens, internal routes (tenant status, resolve player, verify webhook), no operator token on an encoded internal URL (3), audience allow-list at issue (7), route allow-list at the callee (8), service-call audit (9)                                                    | MIO-046, D-4, D-14                                               | `SessionsService.issueServiceToken`, internal controller                     | `apps/identity/src/identity.http.test.ts`                                |
| INV-TEN-1..6 tenant registry (one platform, operator signup, outbox atomicity, slug unique, host resolution, suspended)                                                                                                                                                                                  | MIO-030 AC1,3; MIO-031 AC2                                       | `TenantsService` + tenants repository                                        | `apps/identity/src/identity.tenants.test.ts`                             |
| INV-STAFF-1..8 `(tenant_id, user_id)`, email unique per tenant, DB roles, provider failure, no provider ids in tokens                                                                                                                                                                                    | MIO-043 AC1,2; MIO-040                                           | `StaffService`, `SessionsService.login`                                      | `apps/identity/src/identity.staff.test.ts`                               |
| INV-JWT-1..5 issued token shape, JWKS public-only, TTL, rotation, claim validity                                                                                                                                                                                                                         | MIO-042                                                          | `SessionsService`                                                            | `apps/identity/src/identity.tokens.test.ts`                              |
| INV-ACT-1..6 acting sessions                                                                                                                                                                                                                                                                             | MIO-034 AC and negative cases                                    | `SessionsService.startActing`                                                | `apps/identity/src/identity.tokens.test.ts`                              |
| INV-RBAC-1..6 full 64-cell can() matrix (literal), default deny, no null-tenant shortcut, platform_admin only on the platform tenant                                                                                                                                                                     | MIO-045                                                          | `AccessService.can`                                                          | `apps/identity/src/identity.access.test.ts`                              |
| INV-OWN-1..3 404 versus 403                                                                                                                                                                                                                                                                              | MIO-045 AC3, cross-tenant 404, MIO-154 same-tenant player A vs B | `AccessService.authorize`                                                    | `apps/identity/src/identity.access.test.ts`                              |
| INV-ACTAUTH-1..7 acting audited, only way across, coin deny                                                                                                                                                                                                                                              | MIO-034                                                          | `AccessService.authorize`, `SessionsService.startActing`                     | `apps/identity/src/identity.access.test.ts`                              |
| INV-LAUNCH-1..11 launch token admission (incl. revoked or grace-expired key, platform from the key)                                                                                                                                                                                                      | MIO-044 all rejection cases, replay, tenant from key             | `LaunchService.exchange`                                                     | `apps/identity/src/identity.launch.test.ts`                              |
| INV-PLAYER-1..6 one link per triple, concurrency, deposit-then-launch, reader                                                                                                                                                                                                                            | MIO-044                                                          | `PlayersService.resolveOrCreate`, `lookup`                                   | `apps/identity/src/identity.launch.test.ts`                              |
| INV-CRED-1..6 credentials, webhook tenant from key, rotation                                                                                                                                                                                                                                             | MIO-031 webhooks, MIO-044                                        | `CredentialsService`                                                         | `apps/identity/src/identity.credentials.test.ts`                         |
| INV-EDGE-1..14 HTTP edge (header ignored, forged token, host resolution, validation, 404, acting over HTTP, +929/+931 expiry (11), acting audit produced (12) and consumed (13), every response parses with its contract schema (14))                                                                     | MIO-031, MIO-034, MIO-045, D-11, F14                             | guards + controllers                                                         | `apps/identity/src/identity.http.test.ts`                                |
| INV-PERM-1..2 every route declares a permission; undeclared is denied                                                                                                                                                                                                                                    | MIO-045 AC1                                                      | `PermissionGuard`, route walk                                                | `apps/identity/src/identity.http.test.ts`                                |
| INV-DB-1..7 schema enforces uniqueness, RLS, composite FK                                                                                                                                                                                                                                                | MIO-030 AC1,2; MIO-032; MIO-044                                  | migration                                                                    | `tests/compose/src/identity.compose.test.ts`                             |
| INV-STACK-1..8 JWKS public, header placeholder refused by every service and token A + header B served as A on a no-coin route with seeded rows (2b), an operator cannot mint (2c), audience separation, unknown-key token refused by every service (4), service tokens and their allow-list (5), launch and player concurrency over Postgres, launch response shape (6), same email in two tenants on the emulator (7), acting requests in engagement and payments reach the operator audit log (8) | MIO-042 AC1,2                                                    | service-kit bootstrap                                                        | `tests/compose/src/identity.compose.test.ts`                             |
| Contract shapes                                                                                                                                                                                                                                                                                          | n/a                                                              | zod schemas                                                                  | `packages/contracts/src/identity.contracts.test.ts` (green by design)    |

Contract pins (literals, not read from the constant they pin): `COIN_VALUE_ACTIONS` (5), `ACTIONS` (16), `Role.options` (4),
`SERVICE_AUDIENCES`, `PLATFORM_TENANT_ID`, `INTERNAL_PATH_PREFIX`, `SERVICE_CALL_POLICY` (engagement -> payments is exactly five
routes, no credit/mint/adjust route anywhere); the platform binding, the strict service-token claims, the two audit events and the
response schemas are pinned in `identity.contracts.test.ts`.

Reader tests (a stored record is consumed and described correctly): INV-ACTAUTH-3 and INV-EDGE-8 (audit read back by the
operator), INV-PLAYER-3 and INV-PLAYER-4 (link written by deposit is the one launch resolves; operator lookup).

## 5. API contracts

Public (no token): `POST /v1/operators/signup` (201), `POST /v1/auth/login` (tenant from `Host`), `POST /v1/auth/launch`,
`POST /v1/auth/service-token` (client credentials, `ServiceTokenRequest`), `GET /.well-known/jwks.json`, `GET /healthz/*`.

Internal (service token with `aud=identity`, `INTERNAL_ROUTES` in contracts; tenant in the path, except `verifyWebhook`):
`GET /internal/v1/tenants/:tenantId/status` (`TenantStatusResponse`), `POST /internal/v1/tenants/:tenantId/players/resolve`
(`InternalResolvePlayerRequest` -> `InternalResolvePlayerResponse`, calls `PlayersService.resolveOrCreate`),
`POST /internal/v1/webhooks/verify` (`InternalVerifyWebhookRequest` -> `InternalVerifyWebhookResponse`, calls
`CredentialsService.verifyWebhook`; 401 `WEBHOOK_SIGNATURE_INVALID`). Engagement (L3) calls the last two.
Convention for every service's internal endpoints: prefix `/internal/v1/`, service token only, `tenant_id` explicit in path
or body, nothing read from headers.

Responses (contracts, built against by L3 and L5): `TokenResponse` (login, acting, service token), `LaunchResponse`
(`access_token`, `token_type`, `expires_in`, `user_id`, `tenant_id`), `SignupResponse` (`tenant: TenantView`, `user: StaffMember`),
`TenantView`, `StaffMember`, `CredentialSummary` (never the key or secret), `CredentialIssued` (once), `AuditEntry`, `PlayerLookup`.

Protected (bearer, audience `identity`): `POST /v1/auth/acting` (`acting.start`), `POST /v1/staff` (`staff.invite`),
`GET /v1/staff` (`staff.list`), `GET /v1/players/:userId` (`players.read`), `GET /v1/tenants/:id` (`tenant.read`),
`POST /v1/tenants/:id/suspend` (`tenant.suspend`), `GET /v1/credentials` (`credentials.read`),
`POST /v1/credentials/:keyId/rotate` (`credentials.rotate`), `POST /v1/credentials` (`credentials.rotate`),
`GET /v1/audit` (`audit.read`). Bodies and responses are the schemas in `packages/contracts/src/identity.ts`.
Error body: `{code, message, issues?}` (`IdentityErrorBody`).

Events: `identity.tenant.created` v1 (existing); `audit.acting_request` v1 and `audit.service_call` v1 (new, contracts, written by
the entry point of every service, consumed by identity into `audit_log`, section 1.5). Statuses: login, acting, launch and
service-token answer 200; signup and credential issue answer 201.

Removed: `PlatformAdminGuard`, `PLATFORM_ADMIN_TOKEN`, `HEADER_PLATFORM_TOKEN`, `HEADER_TENANT_ID`, `TenancyModule`, the
`x-tenant-id` / `x-principal-id` / `x-platform-admin-token` headers. The other services switch from the header to the token in the
same merge.

**Complete list of foundation files Stage B rewrites or edits (F15).** They are not frozen. Tests obtain tokens from the identity
issuer (compose tests) or from `@ex-mio/service-kit/testing` fixtures with a fixture JWKS (in-process tests), never from a
header. `INV-SCAN-1..4` fails while any of them still pins the placeholder.

- tests: `apps/identity/src/tenants.test.ts`, `packages/tenancy/src/tenancy.test.ts` (header cases, `TenancyModule.forRoot`),
  `apps/payments/src/credits.test.ts` and `apps/engagement/src/projections.test.ts` (both boot `TenancyModule.forRoot()` and send
  headers; they boot `ServiceAuthModule.forService` with fixture JWKS instead), `tests/compose/src/tenancy.compose.test.ts`,
  `tests/compose/src/bus.compose.test.ts` (`x-platform-admin-token`), `tests/compose/src/env.ts` (`PLATFORM_TOKEN`).
- source: `packages/contracts/src/http.ts` (`HEADER_TENANT_ID`, `HEADER_PLATFORM_TOKEN`), `packages/tenancy/src/nest.ts` (header
  resolver and constants, `TenancyModule`), `apps/identity/src/controllers/platform-admin.guard.ts` (delete),
  `apps/payments/src/app.module.ts`, `apps/engagement/src/app.module.ts`, `apps/identity/src/app.module.ts` (use
  `ServiceAuthModule.forService`).
- config: `docker-compose.yml` (drop `PLATFORM_ADMIN_TOKEN`; add `CREDENTIALS_KEK`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `SERVICE_CLIENT_SECRETS` for identity,
  `SERVICE_CLIENT_SECRET` and `IDENTITY_URL` for engagement and payments), `apps/identity/.env.example`,
  `apps/engagement/.env.example`, `apps/payments/.env.example` (same names, dev defaults), `.deckhand/deploy.yml` (the deploy would
  otherwise still require a removed secret and have no `CREDENTIALS_KEK`; signing keys live in the `signing_keys` table, not in env).

## 6. Error codes

All in `IDENTITY_ERRORS` (code -> HTTP status): TOKEN_INVALID 401, TOKEN_EXPIRED 401, TENANT_REQUIRED 401,
INVALID_CREDENTIALS 401, LAUNCH_TOKEN_INVALID 401, LAUNCH_TOKEN_EXPIRED 401, LAUNCH_TOKEN_REPLAYED 401,
WEBHOOK_SIGNATURE_INVALID 401, TENANT_UNRESOLVED 400, VALIDATION_FAILED 400, ACTING_REASON_REQUIRED 400, FORBIDDEN 403,
ACTING_REQUIRED 403, ACTING_FORBIDDEN 403, ACTING_TENANT_MISMATCH 403, TENANT_SUSPENDED 403, NOT_FOUND 404,
EMAIL_TAKEN 409, SLUG_TAKEN 409, TENANT_PLATFORM_EXISTS 409, PROVIDER_UNAVAILABLE 503, INVALID_SERVICE_CREDENTIALS 401,
TENANT_STATUS_UNAVAILABLE 503, SERVICE_CALL_FORBIDDEN 403 (D-14), AUDIT_UNAVAILABLE 503 (D-11). Service errors carry `code`
(a property on the thrown exception); the exception filter maps it to the status and `IdentityErrorBody`.

## 7. Surface the frozen tests import (Stage B builds exactly this)

- `packages/service-kit/src/auth.ts`: `createTokenVerifier({audience, jwks, nowSeconds?}) -> (token) => Promise<AccessTokenClaims>`
  and `createServiceTokenVerifier(same options) -> Promise<ServiceTokenClaims>`; one verifier instance owns one JWKS cache with the
  policy of section 1.4 (`jwks` is an async fetcher returning `{keys}`); `TokenRejectedError {code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED'}`.
  Use `jose` or `node:crypto`; the allow-list is RS256 only; the claim schemas are the ones in `contracts`.
- `packages/service-kit/src/service-auth.ts` (exported from the package index): `ServiceAuthModule.forService(options)` with
  `options = {audience, identityUrl?, jwks?, tenantStatus?, auditPort?, serviceCalls?, nowSeconds?}`: `identityUrl` is the production
  source of the JWKS and tenant status (it reads `/.well-known/jwks.json` and the internal status route with the service's own client
  credentials) and makes the service's outbox the default `auditPort`; `jwks` and `tenantStatus`
  (`(tenantId) => Promise<'active'|'suspended'>`) override it in tests; `auditPort: (event: EventEnvelope) => Promise<void>` and
  `serviceCalls: ServiceCallPolicy` (default `SERVICE_CALL_POLICY`) are test overrides too, and production wiring passes none
  of the four (INV-WIRE-4). At least `identityUrl`, or `jwks`, `tenantStatus` and `auditPort`, is required. Any other key throws. The returned `DynamicModule` has a provider
  `{provide: SERVICE_AUTH_OPTIONS, useValue: options}` (the wiring tests read it) and registers the guard and interceptor
  app-wide, in that order, before any app guard. Also exports `currentAuth()`, `authOf(request)`, `InternalTenantless()` and
  re-exports `Public`. Mode is chosen on the normalised, percent-decoded path (never the raw `req.url` or the query, N2):
  `/internal/v1/...` is service mode (service token only, tenant from `params.tenantId` or `body.tenant_id`, 400
  `VALIDATION_FAILED` when absent, not a UUID, or when path and body name different tenants, unless `@InternalTenantless()`;
  403 `SERVICE_CALL_FORBIDDEN` when `METHOD template` is not in the caller's allow-list), anything else is user mode. Errors: 401
  with the `TokenRejectedError` code, 403 `TENANT_SUSPENDED`, 503 `TENANT_STATUS_UNAVAILABLE`, 503 `AUDIT_UNAVAILABLE`.
- `packages/tenancy`: export `jwtTenantResolver(verify)`; `TenantResolver` may return a promise; `TenantGuard.canActivate`
  becomes async; `TenantGuard` built without a resolver denies everything but `@Public()`; delete the header exports and
  `TenancyModule`. Re-export `IS_PUBLIC` (already exported).
- `apps/payments/src/controllers/coin-action.ts`: `CoinAction(action)`, `NoCoinEffect()`, `COIN_ACTION_KEY`, `NO_COIN_EFFECT_KEY`,
  `ActingCoinGuard` (applied with `@UseGuards` on every payments controller, not as an `APP_GUARD`; with no auth context it
  answers 401); `apps/payments/src/testing/controller-walk.ts` (frozen test helper: `collectControllers`, `routeHandlers`,
  `coinRuleViolations`, a walk of the module tree);
  `apps/payments/src/controllers/index.ts`: `paymentsControllers: Type[]`, which the payments app module serves as its
  `controllers` (`CreditsController` first: `create` is `coins.credit`, `list` is `NoCoinEffect`). Stage A pins only this and the shared entry point; payments' business logic is L2.
- Apps read `IDENTITY_URL`; payments and engagement also read `SERVICE_CLIENT_SECRET`; identity reads `SERVICE_CLIENT_SECRETS`
  (JSON service name -> secret) and `CREDENTIALS_KEK`.
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
  `auditConsumer {handle(envelope)}` (the identity consumer of `audit.acting_request` and `audit.service_call`; idempotent on the
  event id; writes `audit_log` rows with action `acting.request` or `service.call`), `outbox {events()}` (also holds the audit events
  identity's own entry point writes), `provider {calls, subjectFor(userId)}`. Signatures are as the tests call them. The kernel must
  use the same services the controllers use, not a parallel implementation. In-memory repositories must `await` between
  a read and the following write (F16), so a check-then-insert without a lock or unique key fails `INV-LAUNCH-5` and
  `INV-PLAYER-2` instead of passing by luck of synchronous code.
- `apps/identity/src/testing/app.ts`: `createTestApp({extraControllers?, serviceClients?}) -> {app, kernel}`: a Nest Fastify app
  booted through `ServiceAuthModule.forService` (fixture `jwks` and `tenantStatus` from the kernel), with the real guards,
  controllers and filter over that kernel; `serviceClients` is the service name -> secret registry (audiences and routes come from `SERVICE_CALL_POLICY`); its `auditPort` is
  the kernel outbox; `BASE_DOMAIN` is `mio.test`.
- Migration `apps/identity/src/model/migrations/<ts>-IdentityCore.ts`: tables `tenants` (adds `type`, `status`, `domains`;
  partial unique index on `type` where platform), `users (tenant_id, id, email nullable, kind)`, `user_roles`,
  `provider_links`, `player_links`, `launch_jti (tenant_id, jti, expires_at)`, `integration_credentials`, `audit_log`,
  `signing_keys` (platform table, no `tenant_id`). Tenant tables: PK `(tenant_id, id)`, composite FKs,
  `enableTenantRls`. Unique `(tenant_id, email)` where email not null; `player_links` unique on
  `(tenant_id, platform, external_player_id)` and on `(tenant_id, user_id)`. Seed the platform tenant in the migration with
  id `PLATFORM_TENANT_ID`. Columns the compose tests write: `users (tenant_id, id, email, kind)`,
  `user_roles (tenant_id, user_id, role)`, `player_links (tenant_id, user_id, platform, external_player_id)`,
  `launch_jti (tenant_id, jti, expires_at)`, `audit_log (tenant_id, id, occurred_at default now(), actor_user_id,
actor_tenant_id, acting_tenant_id, action, reason)` (no foreign key on the actor columns, the actor may belong to another tenant),
  `tenants (id, type, name, slug, status)`.

## 8. Out of scope (other specs or later tasks)

Refresh tokens and family revocation (MIO-042 tail; deferred for the submission, listed in the README under "next", D-6 Q2),
sign-in rate limit and lockout (MIO-043 AC3), `operator.signed_up` analytics event, tenant `trial` status, the broker
publisher check and per-service broker users (MIO-046 AC3), Cognito or Identity Platform adapters (MIO-041), the
`firebase-emulator` adapter contract suite beyond `INV-STACK-7`, websocket channel isolation (MIO-033), coin endpoints
themselves and payments' own RBAC matrix (payments spec, L2; this epic pins only that an operator cannot mint, 1.7), binding the
tenant to a service token (token exchange; owner question Q-A, not decided), the engagement-side cache of `user_id`. Stage B may add the provider contract suite for `fake` and the emulator adapter, but the
frozen tests above do not depend on it.

## 9. How to run

Check `uptime` first and wait while the 1-minute load is above 20. Prefix with `nice -n 10`:
`cd apps/identity && nice -n 10 npx jest --maxWorkers=1`, `cd packages/service-kit && nice -n 10 npx jest --maxWorkers=1`,
`cd packages/contracts && npx jest`, `cd apps/payments && npx jest --maxWorkers=1 acting-ban wiring`, same for engagement.
Compose tests, only under the lock: `flock <lock-file> docker compose up -d --wait` (one stack at a time on the host),
then `cd tests/compose && npx jest --runInBand identity`, then `flock <lock-file> docker compose down -v`. Compose tests are red today
(missing tables, no JWKS route, no service-token route, no emulator tenants).

## 10. Review findings to changes (Stage A fix round)

| Finding                      | Change                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 JWKS cache vacuous        | `auth.test.ts` INV-TOK-6: one verifier instance, fetch counter, TTL 300 s, refetch throttle 30 s, fail closed; policy in 1.4                       |
| F2 wiring not reached        | `service-auth.test.ts` (INV-AUTH), `wiring.test.ts` in payments and engagement, `no-header-tenant.test.ts`, INV-STACK-2b; no resolver option (1.5) |
| F3 coin ban in identity only | `acting-ban.test.ts` in payments (D-5); `ActingCoinGuard` named in 1.7; audit outside identity stated as an open point                             |
| F4 loop sized from constant  | literals in `identity.access.test.ts`, `acting-ban.test.ts`; pins in `identity.contracts.test.ts`                                                  |
| F5 s2s missing               | D-4 applied: 1.11, contracts, INV-S2S, INV-AUTH-8, INV-TOK-10, INV-STACK-5                                                                         |
| F6 revoked launch key        | INV-LAUNCH-10                                                                                                                                      |
| F7 platform from the claim   | INV-LAUNCH-11 (two tests); rule in 1.9                                                                                                             |
| F8 platform_admin binding    | `PLATFORM_TENANT_ID`; INV-TOK-8, INV-RBAC-6, INV-TEN-1 (fixed id), INV-DB-1; schema refine in contracts                                            |
| F9 vacuous RLS test          | INV-DB-6 seeds rows, clears the tenant, expects 0 rows and only 42501                                                                              |
| F10 acting body and header   | INV-EDGE-9 body and header variants                                                                                                                |
| F11 partial matrix           | INV-RBAC-1 literal 64 cells with a length assertion                                                                                                |
| F12 PEM confusion, no kid    | INV-TOK-2 two added tests                                                                                                                          |
| F13 stack test labels        | INV-STACK-3 `toBe(200)`; INV-STACK-4                                                                                                               |
| F14 response schemas         | `LaunchResponse`, `SignupResponse`, `StaffMember`, `TenantView`, `CredentialSummary` and the internal DTOs in contracts                            |
| F15 rewrite list             | section 5, enforced by INV-SCAN-3 and INV-SCAN-4                                                                                                   |
| F16 in-memory concurrency    | INV-STACK-6 (compose twin); kernel must yield (section 7)                                                                                          |
| Q1 to Q4                     | D-6 and D-7: tenant status cache (INV-AUTH-7), skew (INV-TOK-9), INV-STACK-7                                                                       |

Round 2 findings and decisions D-11 and D-14 (round 3):

| Finding                                   | Change                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 expiry contradicts the skew            | INV-JWT-4, INV-ACT-5, INV-EDGE-11 probe +929 s valid and +931 s expired; INV-AUTH-3 pins the same window at the entry point; rule in 1.4                       |
| N2 raw-URL mode, encoded path             | INV-AUTH-8 encoded and query cases (user token 401, service token served), INV-AUTH-10 encoded forbidden route, INV-S2S-3 operator on `/%69nternal/`, INV-STACK-5; 1.11 and 7 |
| N3 guard list, child modules              | INV-ACTBAN-7 and INV-WIRE-3 walk the module tree (`controller-walk.ts`), INV-ACTBAN-8 route scan plus a child-module fixture; 1.7                              |
| N4 operator minting pinned                | INV-ACTBAN-2 rewritten (services run value actions; operator on `POST /v1/credits` is 403), INV-ACTBAN-6 uses a service token, INV-STACK-2b on a no-coin route with seeded rows, INV-STACK-2c |
| N5 guard without auth context             | INV-ACTBAN-9: 401 on a coin route and a no-effect route in an app without the entry point                                                                     |
| N6 service-token scope (D-14)             | `SERVICE_CALL_POLICY` in contracts (pinned); INV-S2S-7 (issue), INV-S2S-8 and INV-AUTH-10 (callee), INV-AUTH-8 path/body tenant, INV-S2S-6 policy matches the routes, INV-STACK-5 |
| N7 / F14 response schemas unread          | INV-EDGE-14 parses signup, login, staff, tenant, credentials, audit, player lookup and launch; INV-STACK-6 parses the launch response; contracts pin the strictness |
| N8 JWKS cache through the entry point     | INV-AUTH-3: five requests, one key-set fetch                                                                                                                   |
| N9 stale audit text                       | 1.5 and 1.7 rewritten for D-11; request-level and permission-level rows both kept, told apart by `action`; INV-EDGE-8 unchanged (no events delivered)          |
| D-6 Q2 README                             | `README.md` section "Next" lists refresh tokens and family revocation                                                                                          |
| D-11 items 1 to 6                         | INV-AUTH-9 (service-kit): allowed with a clean route, handler error, no event for ordinary/service/forged/expired tokens, fail closed 503, one event per request   |
| D-11 item 3                               | INV-AUTH-9 in `acting-ban.test.ts`: acting `POST /v1/credits` refused by the guard, one refused event, `credit` not called                                   |
| D-11 item 7                               | INV-WIRE-4 in payments and engagement: no audit, allow-list or key-source override in production options                                                      |
| D-11 item 8                               | INV-EDGE-12 (producer, identity's own entry point), INV-EDGE-13 (consumer: one row per event id, readable, tenant isolated, service-call rows)                 |
| D-11 item 9                               | INV-STACK-8 (compose): acting tokens on engagement (allowed) and payments (refused), both in the operator's `GET /v1/audit`                                    |
| Q-B (audit failure)                       | decided fail closed, pinned in INV-AUTH-9; Q-A (tenant binding) and Q-C (suspended tenant internal calls) stay owner questions, not pinned                    |
