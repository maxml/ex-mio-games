# Decision log (D-1 to D-31)

Tests, comments and docs in this repository cite decisions as `D-<n>`. This page resolves them.
Each entry has the decision, the reason, and where it is enforced. A decision came either from the
owner or from the coordinating AI agent that answered a reviewer finding inside the owner's rules;
`ai/decisions.md` says which. Paths are relative to the repository root. Searching a test or file
name from this page finds the enforcing code.

## Money and events

**D-1. Payments credits every spin.** Engagement writes `spin.completed` to its outbox in the same
transaction as the spin result. Payments consumes it from its inbox and credits coins with the
idempotency key `spin:<spin_id>`, in the same transaction as the inbox row. Delivery is at least
once, the effect happens once. The spin response returns the reward, not the balance. The coin
reserve for a redemption stays a synchronous internal call, idempotent per phase.
Reason: the owner's rule that payments owns every coin operation.
Enforced in: `apps/payments/src/services/inbox.handler.ts`, `apps/engagement/src/redemptions/ports.ts`,
`apps/engagement/src/services/redemption-saga.test.ts`.

**D-2. One casino adapter port.** It is defined once in `packages/contracts/src/casino-adapter.ts`.
Issue returns `issued`, `pending`, `rejected` or `unknown`. A status lookup by our idempotency key
returns `issued`, `pending`, `rejected`, `not_found` or `unknown`, and a timeout is `unknown`, never a
failure. A refund is allowed only after `rejected`, or after `not_found` past the issue deadline,
never after `unknown`.
Reason: two areas had defined their own port.
Enforced in: `packages/contracts/src/casino-adapter.contracts.test.ts`,
`apps/engagement/src/integrations/adapters.contract.test.ts`.

**D-3. Same idempotency key in parallel.** An in-flight duplicate gets 409 (retryable), a later replay
returns the stored result, a changed body gets 422.
Reason: one rule for every write endpoint.
Enforced in: `apps/engagement/src/services/spin.service.ts`,
`apps/engagement/src/services/redemptions.service.ts`, `tests/compose/src/store.compose.test.ts`.

**D-9. Payments idempotency per reserve, contract owners, inbox retries.** Capture, release and refund
are idempotent by the state of the reserve id: a repeat of an applied transition returns the stored
result, only a conflicting one (capture after release) is refused. The producer owns an event
contract: engagement owns `spin.completed` and the adapter port, payments owns coin events and the
reserve API. Balances in command paths come from Postgres, never the cache. A transient inbox error
(connection, timeout, deadlock) retries with backoff and only a permanent error or exhausted retries
reach the dead-letter queue, which has a replay command. The payments app role has exact grants in
one migration, pinned by a test.
Reason: reviews of the money and ingest specs found conflicting replays and a dead-letter queue that
swallowed transient errors.
Enforced in: `apps/payments/src/model/migrations/1732300001000-AppRoleGrants.ts`,
`packages/bus/src/inbox.ts`, `packages/bus/src/replay.ts`, `packages/bus/src/bus.test.ts`.

**D-13. `sandbox` on the event envelope.** An optional `sandbox` flag, set only by the producing
service from server-side state (the integration credential's environment), never from client input.
Metering skips sandbox events, and sandbox effects use separate sandbox wallets and resources, so
the flag cannot remove a paid operation from the bill.
Reason: a sandbox flag must not be a way to avoid billing.
Enforced in: `apps/engagement/src/controllers/principal.ts`, `apps/engagement/src/services/spin.service.ts`,
`apps/payments/src/services/usage.service.ts`; the environment-scoped credit rule is pinned by the
compose test `INV-SPIN-ENV-DB` (see `ai/case-studies.md`, case 1).

**D-18. Operator resolutions move coins only on evidence.** An operator saying `issued` captures coins
only after a status lookup by our key returns `issued`; on `unknown` or `pending` the redemption stays
in review. An operator `not_issued` after a refused reserve returns stock and the per-player limit slot
exactly once. The order idempotency key includes the sandbox flag. Inbox dedupe is per
(tenant, event id).
Reason: the operator's word alone never moves money (also D-15, Q-6).
Enforced in: `apps/engagement/src/services/redemption-saga.service.ts`,
`apps/engagement/src/redemptions/testing/stage-b-conformance.ts`,
`apps/engagement/src/services/redemption-saga.stageb.test.ts`.

**D-8. Redemption saga gaps.** Because the coin reserve is synchronous (D-1), `POST /redemptions`
returns 409 `insufficient_funds` immediately. Replay from review to unknown is allowed only for a
review entered from unknown, never after coins were released or refunded. Stock is returned exactly
once on every path. The casino is called only after the ISSUING state is durably stored; the test
drives the crash itself. Saga inbox dedupe is pinned. The fake store must be atomic and its
conformance suite runs against Postgres too.
Reason: two money defects found in the saga review (stock returned twice, a reward issued with no
coins held).
Enforced in: `apps/engagement/src/redemptions/testing/store-conformance.ts`,
`apps/engagement/src/redemptions/testing/transition-oracle.ts`,
`apps/engagement/src/controllers/store.controllers.test.ts`.

**D-20. Review answers for payments.** A late capture on a refunded reserve gets
`reserve_already_refunded`; the redemption side treats it as consistent only if its own order is
already released or refunded, otherwise it goes to review. No webhook secret falls back to a value in
the source, and production boot fails if it is missing. Reconciliation and usage reporting have a
caller: a periodic job in the payments worker plus a CLI. Payments infrastructure uses the shared
owner/app role split.
Reason: gaps found in the payments review: codes that did not match, a secret with a default, jobs
with no caller.
Enforced in: `apps/payments/src/ledger-report.ts`, `apps/payments/src/config.ts`,
`apps/engagement/src/redemptions/http-coins.client.ts`.

## Identity, tenancy and service-to-service auth

**D-4. Service-to-service auth.** Identity issues short-lived service tokens by client credentials
(`sub=svc:<name>`, `aud=<target>`, `scope=internal`, no tenant). Internal routes
(`/internal/v1/...`) accept only service tokens with the right audience and take `tenant_id`
explicitly. There is one auth entry point in the service kit and it has no tenant resolver option. A
forged `x-tenant-id` is ignored everywhere, and a source scan proves no header-based tenant code
remains.
Reason: trusting a header for the tenant was a hole.
Enforced in: `packages/service-kit/src/service-auth.ts`, `packages/service-kit/src/service-auth.test.ts`,
`apps/engagement/src/controllers/ingest.controller.test.ts`.

**D-5. Acting tenant and coins.** A token carrying `acting_tenant` (an administrator acting as a tenant)
may not move coins. Payments refuses at its choke point, tested in payments; the list of coin-value
actions is pinned by a separate test.
Reason: an administrator acting as a user must never be able to move coins.
Enforced in: `apps/payments/src/acting-ban.test.ts`, `apps/payments/src/coin-action.test.ts`,
`apps/engagement/src/controllers/acting-ban.guard.ts`.

**D-6. Token lifetime.** The verifier checks a cached tenant status, at most 30 s stale, so a suspended
tenant's tokens are refused within 30 s. Refresh tokens are deferred (15-minute access TTL, listed as
future work). Clock-skew leeway is 30 s on `exp`, `nbf` and `iat`, with a test.
Reason: bound the damage of a stolen or suspended token without building refresh now.
Enforced in: `packages/service-kit/src/auth.test.ts`, `packages/service-kit/src/service-auth.test.ts`,
`packages/contracts/src/identity.ts`.

**D-7. Per-tenant identity provider accounts.** The adapter uses the emulator's multi-tenancy, one
provider tenant per product tenant, and a contract test against the emulator proves the same email can
register in two tenants.
Reason: the same person can use two tenants.
Enforced in: `apps/identity/src/services/firebase-emulator-provider.ts`,
`apps/identity/src/services/identity-provider.ts`, compose env in `tests/compose/src/env.ts`.

**D-11. Auditing acting requests.** The service kit's auth entry point writes an `audit.acting_request`
event through the service's outbox for every request carrying `acting_tenant`, allowed or refused, and
identity consumes them into its audit log. No other service adds code of its own.
Reason: one place, one test, no per-service drift.
Enforced in: `packages/service-kit/src/service-auth.ts`, `packages/service-kit/src/service-auth.test.ts`
(INV-AUTH-9), `tests/compose/src/identity.compose.test.ts` (INV-STACK-8).

**D-14. Service-token scoping.** Each service client has an allow-list of target audiences and internal
routes, held in the identity client registry and checked by the callee's entry point. Operators can
never mint coins. Internal routes match on the normalised, decoded path (`/%69nternal/` is
`/internal/`). The acting-coin guard covers every coin route, and a scan test enumerates the routes.
Expiry tests use TTL plus skew. Identity's first spec got exactly one more narrow round.
Reason: a service token must not call routes it has no business with, and encoding tricks must not
bypass the prefix.
Enforced in: `apps/engagement/src/redemptions/http-coins.client.ts`, `apps/engagement/src/app.module.ts`,
`apps/payments/src/acting-ban.test.ts`, `packages/service-kit/src/service-auth.test.ts`.

**D-21. Players and the two-step audit.** Players have no identity-provider account; a casino launch
token yields our own player token. The audit is two-step: an `audit_intents` row is inserted before the
handler (fail closed with 503), and finalize writes the event with the real decision and deletes the
intent in one transaction; a sweeper publishes intents older than 60 s as `aborted`. Test helpers are
excluded from the production build. A reviewer's algorithm-pin test is carried in.
Reason: the provider refused anonymous sign-up, and an event published before the outcome was known
described a request that had not finished.
Enforced in: `apps/identity/src/identity.launch.test.ts` (INV-LAUNCH-1),
`apps/identity/src/model/migrations/1732300001000-AuditIntentsAndGrants.ts`,
`apps/payments/src/model/migrations/1732300002000-AuditIntents.ts`,
`tests/compose/src/audit-intents.compose.test.ts`.

**D-22. Session audiences and web follow-ups.** A launch-token exchange returns one player session valid
for every audience the player needs, so one single-use exchange suffices. The realtime ticket route is
an identity route. Player and operator list routes belong to engagement. The colour gate stays strict
and reads the theme token instead of a hex literal.
Reason: one exchange per launch and a single owner per route.
Enforced in: `apps/identity/src/controllers/identity.controllers.ts`,
`apps/identity/src/identity.realtime-ticket.test.ts`, `apps/identity/src/identity.launch.test.ts`.

**D-23. Realtime ticket.** The session audience array is `[identity, engagement, payments]`; `realtime`
appears only in a ticket, never a session, and no login, acting or launch body can request it. Single
use lives in identity (a Postgres row with `consumed_at`), and the gateway redeems through an internal
identity route with a service token. Every service that takes the shared audit port ships its own
`audit_intents` migration and grants.
Reason: a ticket that could be replayed or requested by the client would defeat socket auth.
Enforced in: `apps/engagement/src/realtime/ticket-redeemer.ts`,
`apps/engagement/src/realtime/ticket-redeemer.test.ts`, `apps/identity/src/controllers/identity.controllers.ts`,
`apps/engagement/src/model/migrations/1732500000000-AuditIntents.ts`.

**D-12. Engagement roles and raw player ids.** Engagement has an owner role for migrations and a
separate non-owner runtime role. Inbound events store a per-tenant HMAC of the casino's player id, not
the raw value; the raw id lives only in the player-mapping table, which erasure deletes. The casino
port gains an adapter registry per tenant, an issue deadline after which `not_found` is final, and a
`sandbox` flag. Events carry only the internal player id. Tests use signed fixtures, not tenant
headers.
Reason: guards must not be undoable by the app role, and personal data must be erasable.
Enforced in: `apps/engagement/src/controllers/ingest.controller.test.ts`,
`apps/engagement/src/integrations/adapter.ts`, `apps/engagement/src/controllers/principal.ts`.

**D-15. Contract reconciliation answers.** Webhooks use each casino's own signature scheme, verified in
the engagement adapters, with secrets held by identity and served only to the engagement service.
Engagement refuses coin-moving actions for a token carrying `act`, and payments keeps its own guard as
defence in depth. `audit.acting_request` is the one cross-service event name exception. The acting
reason is 8 to 500 characters. The operator's word alone never moves coins or stock. The `sandbox`
value derives from the credential that authenticated the webhook or launch. Work continues on one
integration branch in a fixed merge order.
Reason: the task requires different external schemas per casino, and the four areas had defined
overlapping contracts.
Enforced in: `apps/engagement/src/controllers/acting-ban.guard.ts`,
`apps/engagement/src/integrations/casino-a.adapter.ts`, `apps/engagement/src/services/redemption-saga.service.ts`.

**D-24. Audit decision and queue tables.** The audit `decision` records the authorization outcome, not
the HTTP outcome: `refused` only when a guard refused, otherwise `allowed` with the real status. Every
tenant-scoped table has forced row-level security, including work queues; a truly global table must be
named in the roles test allow-list with a reason. Frozen tests that call removed routes are rewritten
by their owner, keeping the property they pin.
Reason: the audit log must describe authorization; see `ai/case-studies.md`, case 2.
Enforced in: `packages/service-kit/src/service-auth.ts`, `apps/engagement/src/controllers/acting-ban.guard.ts`,
`apps/engagement/src/model/migrations/1732600000000-WorkQueueRls.ts`, `tests/compose/src/roles.compose.test.ts`.

## Realtime

**D-10. Realtime security.** Socket.IO `connectionStateRecovery` stays off, because in the version used
it restores rooms and sends missed packets before middleware runs, bypassing auth. The socket uses a
one-time ticket (`aud=realtime`, at most 60 s) obtained over HTTP through the web backend. Rooms are
`t:{tenant}:{kind}:{id}`, built on the server, and every join is authorized. There is no missed-event
replay; the client resyncs over REST after a reconnect.
Reason: a library behaviour that skipped authentication.
Enforced in: `apps/engagement/src/realtime/realtime.gateway.ts`, `apps/engagement/src/realtime/rooms.ts`,
`apps/engagement/src/realtime/realtime.gateway.test.ts`.

**D-25. Realtime gateway host.** The owner required a websocket and no server gateway existed.
Engagement hosts the Socket.IO gateway (namespace `/rt`), redeeming tickets through identity (D-23)
and pushing spin results, balance changes and redemption status, at most once, with a REST resync
after reconnect. Pushes leave only after the handler's transaction commits.
Reason: the websocket is mandatory; engagement already consumes the events.
Enforced in: `apps/engagement/src/realtime/realtime.gateway.ts`, `packages/contracts/src/realtime.ts`,
`apps/engagement/src/realtime/realtime.gateway.test.ts` (`COMMIT-ONLY`).

## Environments, audit scope and demo gaps

**D-26. A third occurrence of a defect class is closed at its choke point.** The final release-candidate
review found two classes that earlier rounds had "fixed": environment scoping (spin credits, then
integration secrets, then ingest dedupe) and the audit decision (first the HTTP status, then refusals
inside a handler). By D-17 the call sites stop being patched and both become invariants.
INV-ENV: every table that holds environment-scoped data carries `sandbox`, and every unique constraint,
primary key and dedupe or idempotency key on such a table includes `sandbox` (or `environment`). Keys
built in code go through one helper that requires the environment. INV-AUD: the audit `decision` is
`refused` for every authorization refusal, whether a guard or a policy check inside a service raised it
(one typed error, `AuthorizationRefused`); every other outcome is `allowed` with its real status. This
supersedes the literal wording of D-24.
Reason: three rounds on the same class showed that call-site fixes move the defect.
Enforced in: `packages/contracts/src/events.contracts.test.ts` (`INV-ENV-SANDBOX`), the schema scan
over `pg_constraint` in `tests/compose/src/inv-env-schema.compose.test.ts` (`INV-ENV-SCHEMA`) and the
role-matrix audit test in `tests/compose/src/inv-aud-matrix.compose.test.ts` (`INV-AUD-MATRIX`). Both
compose tests are in this tree; their re-run on the final tree is tracked in `submission/known-gaps.md`
(S-11).

**D-27. Gaps found by the end-to-end demo.** The operator registers each casino's reward API (base URL
and a per-environment signing secret) in identity, which serves it to engagement as `reward_api`;
without it an order goes to `NEEDS_REVIEW` with `no_adapter`, the fail-safe. Engagement gets audited
`PUT /v1/operator/wheel` (versioned segments and weights, sum above zero) and `PUT /v1/operator/rules`
(deposit to spins) for `operator_admin`, and a new tenant gets a default wheel and rule on signup.
The operator reads the provider subscription id from `GET /v1/operator/plan` (payments). The web
runtime config returns `realtimeUrl`, and engagement allows the web origin; the same-origin
`/socket.io/*` rewrite stays as a fallback, not as the main path. `scripts/demo.sh` is the acceptance
test: its setup steps may use the new routes, its assertions are never edited by the implementer.
Reason: the recorded demo showed no rule, no reward API and a broken socket path on a fresh stack.
Enforced in: `apps/identity/src/identity.reward-api.test.ts`,
`apps/engagement/src/controllers/operator-config.controller.test.ts`,
`apps/engagement/src/integrations/tenant-ports.test.ts`, `apps/web/src/layers/shared/config/runtime.test.ts`.

**D-28. Defaults for the invariant-test owner.** The audit log records acting requests and service
calls (D-11); a refusal for an ordinary operator, viewer or player goes to the structured log, not to
the audit log. One user serves both environments, and the environment comes from the credential or the
launch token, never from the user. A sandbox order skips the stock step and the per-player limit, and
carries `sandbox=true`; `store_items` stays global and `item_player_usage` includes `sandbox`.
`POST /v1/spins` requires the `player` role; acting principals and operators are refused. The owner may
override these defaults.
Reason: the invariant tests of D-26 needed a stated answer for each of these cases.
Enforced in: the sandbox order rule by the saga (`apps/engagement/src/services/redemption-saga.service.ts`);
the role and audit-scope rows are pinned by the role-matrix test `tests/compose/src/inv-aud-matrix.compose.test.ts`.

**D-29. The environment is a required input everywhere (INV-ENV-INPUT).** A fourth defect of the
environment class (a default on the reward-API `environment`, a realtime ticket that always said
production, a test fake that ignored `sandbox`) led the owner to choose a short spec over a narrow fix.
The rule: every environment input is required and typed; no `.default()` and no fallback exists for
`environment`, `sandbox` or `sbx`; the environment comes only from the verified credential or launch
token (D-28); every durable record scoped by environment stores the real value; and an in-memory fake
must agree with Postgres on environment behaviour, so one conformance suite runs against both. Requests
that now answer 400 `VALIDATION_FAILED` without an environment are listed in the root README.
Reason: three rounds of call-site fixes had moved the defect (D-17, D-26).
Enforced in: `docs/specs/env-input.md`, `apps/identity/src/review-env-input.test.ts`,
`apps/engagement/src/redemptions/testing/review-final-sandbox-conformance.ts`, and the migrations
`1732900000000-DropEnvironmentDefaults.ts` in identity and engagement.

**D-30. Reward API, tickets and credentials after the early review (owner answers).**
`TENANT_SUSPENDED` is an authorization refusal and audits as `refused`. The wire-key format change is
accepted because no order is in flight before launch; it ships with a release note (root README), and
the tests pin the literal wire keys. Realtime tickets and pushes are per environment, taken from the
launch token. A reward API must be https in production; http is allowed only for hosts listed in
`REWARD_API_ALLOW_HOSTS` (compose lists `casino-sim`). The PUT also refuses credentials in the URL and
internal addresses, the transport never follows a redirect, and the casino's failure reason is
truncated and sanitised. Credentials take a required `environment` with no production default, which
supersedes the earlier default under D-29.
Reason: an operator-supplied URL is a server-side request, and a default environment is how sandbox
and production got mixed.
Enforced in: `apps/engagement/src/integrations/reward-api-https.test.ts`,
`apps/engagement/src/integrations/review-final-ssrf.test.ts`,
`apps/engagement/src/integrations/review-env-input-reason.test.ts`,
`apps/engagement/src/realtime/rooms.test.ts`, `apps/identity/src/review-env-input.test.ts`.

**D-31. Re-review of the fix round.** (1) The change to the ingest dedupe primary key ships as a new
forward migration; an applied migration is never edited, and a test pins a checksum of every migration
that has shipped. (2) "https only in production" means the deployment (`NODE_ENV=production`), for
every reward API, sandbox and production integrations alike; http is allowed only for hosts in
`REWARD_API_ALLOW_HOSTS` or outside production, with the same rule in identity (the PUT rejects) and in
engagement (the call refuses), through one shared helper. (3) `audit_intents` in the three service
databases gets `tenant_id` with row-level security enabled and forced like every tenant table (D-24),
and the roles and RLS scan covers it. (4) Default, which the owner may override: support staff acting as
an operator are refused on every integration or configuration write (`PUT reward-api`, `PUT wheel`,
`PUT rules`), audited as `refused`, in identity and in engagement.
Reason: the first fix round moved defects instead of closing them (D-17, D-26).
Enforced in: (1) `packages/service-kit/src/review-migrations-immutable.test.ts` and
`packages/service-kit/src/review-fr2-migrate.test.ts`; (2) `apps/identity/src/review-r2-reward-api.test.ts`;
(3) `packages/service-kit/src/review-fr2-audit-intents-rls.test.ts` and
`tests/compose/src/review-fr2-audit-intents-default-deny.compose.test.ts`, plus the roles and RLS scan;
(4) `apps/engagement/src/controllers/review-r2-acting-config.test.ts`,
`apps/engagement/src/controllers/review-fr2-acting-store.test.ts` and
`apps/identity/src/review-fr2-acting-integration.test.ts`. The compose, `test:db` and `test:pg` suites
passed on this code on 2026-11-22 (the integration branch at `2aa4b7a`: 250 of 250, 181 of 181, 50 of 50; see S-12 in
`docs/submission/known-gaps.md`).

## Process and analytics

**D-16. One integration branch per epic.** Contracts and shared helpers first; identity, payments,
engagement and web each branch from it, merge their spec branch and then their implementation branch,
and reach `main` in that order after review. A later contract change goes to the contracts branch first.
Reason: reconciliation fixes are made once.
Enforced in: the merge history of the repository (`git log --merges`). No test cites it.

**D-17. Round limit.** If round three of a review still finds a defect class, the work restarts from a
spec. There is no "one more minor round", and a fix that did not close its findings is redone and does
not count as a round. D-14's extra round for identity was the last exception.
Reason: a patch loop on one area did not converge.
Enforced in: the review process (`ai/README.md`, step 8); not testable in code.

**D-19. Product events follow Varta's envelope.** `logProductEvent` in `packages/logger` and the
`ProductEventLine` contract match Varta's product-event schema exactly: a closed envelope, flat scalar
props with a key pattern, ASCII ids with caps, a fixed timestamp format, lines of at most 8 KiB. A
conformance test validates emitted lines against a vendored copy of the schema, whose origin is
recorded in `packages/contracts/schemas/varta-product-event.schema.SOURCE`.
Reason: all analytics go through one panel (Varta); the two sides must not drift.
Enforced in: `packages/logger/src/product-event.test.ts`, `apps/engagement/src/analytics.test.ts`,
`apps/identity/src/identity.analytics.test.ts`, `apps/payments/src/analytics.test.ts`,
`apps/web/src/layers/shared/api/bff/analytics.test.ts`.
