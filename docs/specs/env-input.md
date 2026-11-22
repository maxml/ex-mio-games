# Spec: environment input (INV-ENV-INPUT)

Status: Stage A (spec only; the reviewer writes the red tests, the coder makes them green). Base: `int/final`
e6f3ff4. Binding decisions: D-13 (sandbox on the envelope, server-side only), D-26 (INV-ENV schema level),
D-28 (the environment comes from the credential or launch token, never from the user), D-29 (this rule), D-30
(F12 supersedes the earlier "default to production"; realtime tickets are per environment).
Findings closed together: F3, F7, F8, F9, F12 of the early review.

## 1. The property

**INV-ENV-INPUT.**

1. Every environment input (`environment`, `sandbox`, `sbx`) is required and typed. A missing value is an error,
   never a value.
2. No zod `.default()` and no fallback (`?? 'production'`, `|| false`, `= { sandbox: false }`, "absent means
   production") for `environment`, `sandbox` or `sbx`, in a schema, a controller, a service or a function
   parameter.
3. The environment comes only from the verified credential or launch token (D-28). A request body or query may
   name an environment only where an operator configures a per-environment resource (credential, reward API),
   and there it is required, not defaulted.
4. Every durable record that is environment-scoped stores the real value, taken from the same source as the
   request that wrote it.
5. A fake agrees with Postgres on environment behaviour. One conformance suite runs against both.

## 2. Inventory of environment inputs and records

Source: C credential, L launch token (`sbx` claim), B request body, Q query, D default, V derived (from a stored
row or an event). Marks: **VIOLATES** breaks the property; ok keeps it. Line numbers are at e6f3ff4.

| #   | file:line                                                                                                                                                                                                                                                                            | what                                                                                                                         | source                  | verdict                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| 1   | `packages/contracts/src/identity.ts:452`                                                                                                                                                                                                                                             | `IssueCredentialRequest.environment`                                                                                         | B, D                    | **VIOLATES** (F12)                                                   |
| 2   | `packages/contracts/src/identity.ts:469`                                                                                                                                                                                                                                             | `PutRewardApiRequest.environment`                                                                                            | B, D                    | **VIOLATES** (F7)                                                    |
| 3   | `apps/payments/src/controllers/coins.controller.ts:33` (use `:113`)                                                                                                                                                                                                                  | `EnvironmentQuery.sandbox` on the internal balance read                                                                      | Q, D                    | **VIOLATES** (F9)                                                    |
| 4   | `apps/identity/src/services/sessions.service.ts:255-267` and `:303`                                                                                                                                                                                                                  | realtime ticket: `issueUserToken` is called without `sbx`; `launch_jti` row written with `claims.sbx === true`, always false | L lost                  | **VIOLATES** (F8)                                                    |
| 5   | `apps/engagement/src/redemptions/testing/memory-store.ts:123-127,165,255-259`                                                                                                                                                                                                        | fake skips stock and limit for production only in Pg (`redemption.store.ts:233-255`)                                         | fake                    | **VIOLATES** (F3)                                                    |
| 6   | `apps/identity/src/services/credentials.service.ts:139`                                                                                                                                                                                                                              | `options.environment ?? 'production'` in `issue`                                                                             | D                       | **VIOLATES** (new, N-1)                                              |
| 7   | `apps/identity/src/services/credentials.service.ts:150`                                                                                                                                                                                                                              | `issueFor(..., environment = 'production')`                                                                                  | D                       | **VIOLATES** (new, N-1)                                              |
| 8   | `apps/payments/src/services/balance.service.ts:40`                                                                                                                                                                                                                                   | `readByPlayer(opts = { sandbox: false })` parameter default                                                                  | D                       | **VIOLATES** (new, N-2)                                              |
| 9   | `packages/service-kit/src/service-auth.ts:110,349`                                                                                                                                                                                                                                   | `AuthContext.sandbox?` is optional; set only when `sbx` is true; absent = production                                         | L, derived              | **VIOLATES** (new, N-3): consumers read `=== true`                   |
| 10  | `apps/engagement/src/controllers/principal.ts:31`, `spin.controller.ts:57`, `spin.service.ts:89,120,133,175,204`                                                                                                                                                                     | `auth.sandbox === true`, `input.sandbox === true`                                                                            | derived from #9         | **VIOLATES** (N-3): the coercion hides a missing value               |
| 11  | `packages/contracts/src/events.ts:31,201`                                                                                                                                                                                                                                            | `EventEnvelope.sandbox` optional; `createEvent` writes it only when true                                                     | D (absent = production) | **VIOLATES** (N-4)                                                   |
| 12  | `apps/engagement/src/services/spin-credits.service.ts:41`, `apps/payments/src/services/balance.service.ts:65`, `inbox.handler.ts:62`                                                                                                                                                 | `event.sandbox === true`                                                                                                     | derived from #11        | **VIOLATES** (N-4)                                                   |
| 13  | DDL `DEFAULT 'production'` / `DEFAULT false`: identity `1732300002000-CredentialEnvironment.ts:13`, `1732300005000-LaunchJtiEnvironment.ts:12`; payments `1732300000000-Ledger.ts:97,108,123`; engagement `1732200002000-IngestSchema.ts:70`, `1732800000000-EnvScopedKeys.ts:19,29` | column defaults on scoped tables                                                                                             | D                       | **VIOLATES** (N-5): a writer that forgets the column gets production |
| 14  | `apps/payments/src/controllers/balance.controller.ts:34`                                                                                                                                                                                                                             | operator reads the production wallet, literal `sandbox: false`                                                               | literal, by design      | ok once #8 is required (the literal is the explicit argument)        |
| 15  | `apps/payments/src/controllers/balance.controller.ts:25`                                                                                                                                                                                                                             | player reads own wallet, `auth.sandbox === true`                                                                             | L                       | ok after #9                                                          |
| 16  | `apps/identity/src/controllers/identity.controllers.ts:212-213`                                                                                                                                                                                                                      | issue credential, passes the parsed field                                                                                    | B                       | ok after #1                                                          |
| 17  | `apps/identity/src/services/launch.service.ts:99,122,131`                                                                                                                                                                                                                            | `sbx` set from the credential row                                                                                            | C                       | ok                                                                   |
| 18  | `apps/engagement/src/services/ingestion.service.ts:73,104,172-189`                                                                                                                                                                                                                   | webhook environment = the key that verified the signature                                                                    | C                       | ok (the `sandbox:false` at `:189` is an unverified, rejected event)  |
| 19  | `apps/engagement/src/controllers/redemptions.controller.ts:45`, `redemption.store.ts` (all `scope.sandbox`)                                                                                                                                                                          | redemption scope from the principal                                                                                          | L                       | ok after #9; Pg and memory must agree (#5)                           |
| 20  | `apps/engagement/src/services/redemption-saga.service.ts:39-40,211,686,703,717,733`                                                                                                                                                                                                  | saga keys and ports use the order's stored flag                                                                              | V (stored)              | ok                                                                   |
| 21  | `apps/engagement/src/integrations/tenant-ports.ts:31-46,86`, `casino-a.adapter.ts:95,125`, `casino-b.adapter.ts:175,184`                                                                                                                                                             | port per environment, `sandboxMismatch`                                                                                      | V (stored)              | ok                                                                   |
| 22  | `packages/contracts/src/identity.ts:351,487,600`, `payments.ts:73`, `casino-adapter.ts:24,94,154`                                                                                                                                                                                    | `environment` / `sandbox` required in the schema                                                                             | B or V                  | ok (required, no default)                                            |
| 23  | `packages/contracts/src/scoped-key.ts:30-62`                                                                                                                                                                                                                                         | `scopedKey` requires a boolean                                                                                               | V                       | ok (already a choke point)                                           |
| 24  | `apps/identity/src/testing/memory-store.ts:280-284`; `apps/payments/src/testing/harness.ts:302`; `apps/engagement/src/redemptions/testing/store-conformance.ts:93` (`?? false`)                                                                                                      | test fakes and helpers                                                                                                       | fake / D                | **VIOLATES** (N-6): make the argument required, no `?? false`        |
| 25  | `apps/payments/src/model/ledger.repository.ts` (32 sites), `apps/engagement/src/model/pg-repositories.ts`, `redemption.store.ts`                                                                                                                                                     | SQL keyed by the passed environment                                                                                          | V                       | ok; covered by the conformance suite (§3.4)                          |

Count: 25 rows covering about 150 individual sites. Five known violations (#1-#5); new ones N-1 to N-6 (#6-#13, #24).
The web package (`apps/web`) only displays a sandbox label and is not an input.

## 3. Choke points

3.1 **Contracts (zod).** In `packages/contracts`, `environment` on `IssueCredentialRequest` and
`PutRewardApiRequest` is `IntegrationEnvironment` with no `.default()`. `EventEnvelope.sandbox` becomes a required
boolean (`createEvent` takes it as a required argument; D-13 still holds: only the producing service sets it).
The internal balance query takes `sandbox` as a required `'true'|'false'`.

3.2 **`Subject` and `AuthContext`.** Both carry `environment: 'production' | 'sandbox'` (or `sandbox: boolean`),
always present, set by the verifier from the token's `sbx` claim. The verifier is the only constructor. Service
tokens have no environment and are given the environment explicitly by the allow-listed route (the body/path
field is required there). `issueUserToken` takes `environment` as required, so a token cannot be signed without
deciding it. The realtime ticket carries it from the `Subject`, and the redeemed principal gets it back (D-30,
F8).

3.3 **`scopedKey`** keeps its required boolean. Every application key (idempotency, inbox, order, dedupe) goes
through it; a scan test fails on a hand-built key.

3.4 **The store port.** Environment-scoped ports take `scope: { tenantId, environment }` as a required argument,
no optional or defaulted form. One conformance suite per port (engagement redemption store, identity store,
payments ledger) runs against the memory fake in the unit run and against Postgres in the compose run, with the
same cases: SBX-1..4 for stock and limit (a sandbox order never touches stock), wallet separation, dedupe keys
differing by environment, the stored `sandbox` equals the input. The fake may not special-case anything the Pg
adapter does not.

3.5 **Schema.** New migrations drop the `DEFAULT` on every scoped column (§2 #13). Existing rows are unaffected.
The D-26 `pg_constraint` scan stays.

## 4. Tests the reviewer writes (name: mutation that turns it red)

| Test                                                                                                                                                                                                                                                                                                                                                                                                        | Mutation                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `INV-ENV-INPUT-1 schema requires environment`: `IssueCredentialRequest`, `PutRewardApiRequest` and the balance query reject a body without it                                                                                                                                                                                                                                                               | add `.default('production')` to any of them                                               |
| `INV-ENV-INPUT-2 static scan`: read the sources of `packages/contracts/src` and every `apps/*/src/controllers`; fail on any `.default(` on a field named `environment`, `sandbox` or `sbx`, and on `?? 'production'`, `?? false` or `= { sandbox: false }` applied to those names in non-test sources. The scan must first prove it sees the files (non-zero count, and a planted fixture string is caught) | add one `.default(` or fallback                                                           |
| `INV-ENV-INPUT-3 auth context is total`: for a token with and without `sbx`, `currentAuth()` always returns a defined environment                                                                                                                                                                                                                                                                           | make the verifier set it only when sandbox                                                |
| `INV-ENV-INPUT-4 ticket keeps environment`: a sandbox launch gives a ticket whose `sbx` is true and whose `launch_jti` row has `sandbox=true`; a production one is false                                                                                                                                                                                                                                    | drop `sbx` in `issueRealtimeTicket`                                                       |
| `INV-ENV-INPUT-5 envelope requires sandbox`: `createEvent` without it fails; a consumer given an envelope without it rejects it                                                                                                                                                                                                                                                                             | restore the optional field                                                                |
| `INV-ENV-INPUT-6 store conformance`: SBX-1..4 and the stored-environment case, one suite, run on both stores                                                                                                                                                                                                                                                                                                | skip stock for sandbox in Pg only, or in the fake only (the suite must go red either way) |
| `INV-ENV-INPUT-7 no DDL default`: scan `pg_attribute`/`pg_attrdef` in each service DB; a scoped column has no default (compose run)                                                                                                                                                                                                                                                                         | re-add `DEFAULT false` in a migration                                                     |
| `INV-ENV-INPUT-8 scopedKey`: keys for the two environments differ; a missing flag throws; a scan finds no hand-built key                                                                                                                                                                                                                                                                                    | make `scopedKey` default the flag                                                         |
| `INV-ENV-INPUT-9 reader`: a durable record (ticket jti, reward API row, credential, redemption) is read back through its API and shows the environment it was written with                                                                                                                                                                                                                                  | write a constant instead of the input                                                     |

Each test header names its mutation. Per the review lessons, the reviewer re-applies each mutation and shows red.

## 5. Behaviour changes

- `POST /v1/credentials` (issue) without `environment`: **400 `VALIDATION_FAILED`** (was a production
  credential). Same for `PUT /v1/operator/integrations/:casino/reward-api` (was a production endpoint).
- The internal balance read (`GET players/:playerId/balance` in `coins.controller.ts`) without `sandbox`: **400
  `VALIDATION_FAILED`** (no caller today).
- Realtime ticket and push: scoped to the launch token's environment; a sandbox player no longer gets a
  production-labelled ticket. No new error.
- A service call or an event without the environment: 400 `VALIDATION_FAILED` at the edge; a consumer drops it to
  the dead-letter path, never treats it as production.
- Docs to update: `docs/CONTRACTS.md` line 42-43 (the envelope `sandbox` is now required, not "absent means
  production"), the credential and reward-API request tables, and the realtime ticket note; `README.md`: the API
  section (the `PUT .../reward-api` line near 203 and the credential issue request, where `environment` is
  required) and the sandbox bullet near 337.

## 6. Out of scope

- The F1 reward-API URL rules, F2 wire keys, F6 audit typing (D-30 covers them separately).
- Changing which environment a casino key belongs to; one user serving both environments (D-28 stays).
- Rewriting existing production rows; renaming `sandbox` to `environment` in columns or events.
- The web console wording.
