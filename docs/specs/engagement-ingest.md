# Spec: engagement ingest, rules and wheel (area L3)

Diagram: section [2](../../docs/architecture/README.md#2-sequence-the-8-step-workflow) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

Backlog: MIO-050..057, 060..064, 069 (fairness core); Part C cases MIO-140, 141, 147, 151, 154 as far as
they touch ingest, credits and spins. Service: `apps/engagement` (module `src/integrations/` and the
rules, credits and wheel code) and `apps/casino-sim`. Status: frozen at Stage A; the coder implements
against the tests named below and never edits them.

## 1. Behaviour

1. A casino (A or B) posts a signed deposit webhook to `POST /v1/integrations/{tenantSlug}/events`.
2. The tenant is resolved from the slug only. The tenant's adapter verifies the casino's OWN signature
   (D-15 Q-1: casino-native, never a MIO `x-mio-*` scheme) and the timestamp window with the tenant's secrets
   (`TenantIntegration.webhook_secrets`, served by identity to `svc:engagement`), then validates the schema.
   The environment of the secret that verified the signature decides `envelope.sandbox` (a production integration may carry a sandbox key set; `TenantIntegration.environment`, X-3) of
   everything this delivery produces; a body or a header can never set it.
3. **Before the transaction** the casino player is resolved to our internal `player_id` through identity
   (`PLAYER_DIRECTORY.resolveOrCreate`, the only writer of the link; X-1, D-12). If identity is unavailable the
   answer is 503 and nothing is written (no inbound row, no event), so the casino's retry is safe. Then, in
   **one transaction**, the event is inserted into `inbound_events` (UNIQUE
   `(tenant_id, sandbox, source, external_event_id)`) and, only if the insert was new, an
   `engagement.deposit.confirmed` v1 message is written to the outbox. The event carries `player_id` and never
   the raw casino player id (strict schema), so the outbox row is not a durable copy of the raw id. A duplicate
   returns 200 with the first delivery's body.
4. The outbox relay publishes; the engagement consumer (`SpinCreditsService.onDepositConfirmed`, inbox
   dedupe) evaluates the tenant's rules for the `player_id` in the event and inserts `spin_credits` rows
   (`available`) plus `engagement.spin.granted`.
5. The player calls `POST /v1/spins` (`Idempotency-Key`, body at most `{credit_id}`). One conditional
   `UPDATE` consumes a credit; the server draws the segment from `HMAC(server_seed[v], spin_id)` against
   the active reward table version; the spin row and `engagement.spin.completed` commit together.
6. Coins for a spin (coordinator decision D-1). Payments owns every coin operation; engagement never
   calls a credit endpoint and never writes balances. The spin writes `engagement.spin.completed` v1
   (`spin_id`, `player_id`, `reward_coins`, required `table_version` (X-16); the tenant and, for a sandbox
   token (`sbx`, X-3), `sandbox: true` are in the envelope, set by this producer, never in the payload) to the outbox
   in the same transaction as the spin row, also for a `nothing` segment (0 coins). Payments consumes it
   through its inbox and credits coins under the ledger key `(spin_award, <spin_id>)` (the business id is
   `spin_id`) in the same transaction as the inbox row; metering reads the same event in payments.
   Delivery is at least once, the effect happens once. The spin response returns the reward, not the new
   balance; the player sees the balance through the payments read API or the Redis projection
   (eventually consistent). The payments consumer is tested in the payments area (see section 12);
   this area pins the event and that the spin path makes no HTTP call.

## 2. State tables

`spin_credits.status`: `available -> used` (only transition; only via the conditional UPDATE; no way back,
enforced in the database by a trigger, section 10).

| inbound delivery                                     | result                                  | row      | outbox    |
| ---------------------------------------------------- | --------------------------------------- | -------- | --------- |
| valid, new                                           | 200 `accepted`                          | inserted | 1 message |
| valid, duplicate (same tenant, source, event id)     | 200, same body                          | none     | none      |
| valid, ignored (status not successful, unknown type) | 200 `ignored`, `inbound_event_id: null` | none     | none      |
| anything rejected (section 9)                        | 4xx                                     | none     | none      |

| spin request                                           | result                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| own `available` credit won                             | 201 `SpinResponse` (`spin_id`, `segment_index`, `segment_label`, `reward_coins`) |
| same `(tenant, user, Idempotency-Key)` again, later    | 201, the recorded spin (same `segment_index`), no second credit used             |
| same key, first request still in flight (parallel)     | 409 code `in_progress` (retryable), nothing else changes                         |
| same key with a different body (`credit_id` changed)   | 422, nothing changes                                                             |
| no available credit, or the named own credit is `used` | 409 code `no_credit` (the client stops)                                          |
| `credit_id` that is not this player's                  | 404, that credit unchanged                                                       |
| body with any other field                              | 422                                                                              |

The two 409s are told apart by the body `{message, code}` (`SpinConflictBody`, `SPIN_CONFLICT_CODES =
in_progress | no_credit`, review R2-5). A same-key duplicate while the first request runs is always
`in_progress`, even if the player has no other credit left; `no_credit` is only for a player with nothing
to spin. The web wheel animates to the server's result, so the spin response carries the winning
`segment_index` (an index into the public segment list of `GET /v1/wheel/:wheelId`) beside the label and
coins; the replay returns the stored index, it is never redrawn.

`GET /v1/me/spins` (coordinator addition for the web area): answers `MySpinsResponse {available: n}`, the
count of the caller's `available` credits (`SpinCreditsRepository.countAvailable`, `user_id` = principal,
`tenant_id` = ambient). It takes no user input (a `user_id` query param is ignored), needs a player token
(401 without), and parses the service result strictly (a leaking object is a 500). Player A never sees B's
count and a tenant never sees another tenant's.

D-3: with the same key in parallel, every response is a 201 with the one stored spin or a 409 `in_progress`; exactly one
credit is consumed, one spin row and one `spin.completed` row exist. Foundation `packages/idempotency`
(`runIdempotent`) or the UNIQUE `(tenant_id, user_id, operation_id)` with the consume in the same
transaction may provide it; the choke point is that consume and spin insert commit or roll back together.
A spin without `credit_id` consumes exactly one credit.

## 3. Casino wire protocols (the simulators implement them, the adapters speak them)

Header names are lower-case. Amounts are integers in minor units; a float is a schema error.

**Casino A** (`source = "casino-a"`, recovery `native_lookup`)

- Webhook body `{eventId, playerId, amount:{value, currency}, status:"SUCCESS"|..., ts}` (`ts` epoch
  seconds). Headers `x-a-timestamp` (= `ts`) and `x-a-signature` = hex `HMAC-SHA256(secret, "${ts}.${rawBody}")`.
  Status other than `SUCCESS` is `ignored`.
- `POST {base}/casino-a/bonuses` `{idempotencyKey, playerId, bonus:{type, amount, currency}}`: 200
  `{bonusId, status:"ISSUED"}`; 422 `{error}` is a final rejection; the same key never issues twice.
  `GET {base}/casino-a/bonuses?idempotencyKey=` 200 same shape or 404.

**Casino B** (`source = "casino-b"`, recovery `idempotent_replay`)

- Webhook body `{type:"payment.completed", data:{txn_id, customer_ref, amount_cents, ccy}, sent_at(ISO), signature}`
  with `signature = hex HMAC-SHA256(secret, JSON.stringify([sent_at, type, txn_id, customer_ref, amount_cents, ccy]))`
  (a JSON array, so the encoding is injective; a dotted string let two different bodies share one MAC, review F4).
  Any other `type` (for example `payment.refunded`) is `ignored`. No signature headers.
- `POST {base}/casino-b/v2/rewards` `{idempotency_key, customer_ref, reward:{type, amount_cents, ccy}}`:
  202 `{ticket}`; the same key returns the original ticket and issues nothing new.
  `GET {base}/casino-b/v2/rewards/{ticket}`: `{state:"PENDING"}`, `{state:"DONE", reward_ref}` or
  `{state:"FAILED", code}`. There is no lookup by our key.

**Adapter contract** (`src/integrations/adapter.ts`): `verifySignature` returns `valid|missing|invalid|stale`
(`stale` only when the MAC is valid and the timestamp is outside +-300 s; an invalid MAC wins over stale;
malformed signatures are `invalid`, never a throw); `parseEvent` is pure and returns
`deposit | ignored | rejected(malformed_json|schema_invalid)`. The reward side is the ONE casino port of
decision D-2, defined in `packages/contracts/src/casino-adapter.ts` (owned by this area; the store area
imports it and defines no port of its own); `adapter.ts` re-exports its types and `CasinoAdapter extends
CasinoRewardPort`:

- `issueReward(request, ourKey)` returns `issued{external_ref}` | `pending{external_ref?}` |
  `rejected{reason}` | `unknown`. It never throws: timeout, transport error and 5xx are `unknown`; a
  business refusal is `rejected`. Casino A answers `issued` or `rejected` only; casino B answers
  `pending{external_ref: ticket}` first.
- `getRewardStatus(ourKey, request)` returns `issued{external_ref}` | `pending{external_ref?}` |
  `rejected{reason}` | `not_found` | `unknown`. It looks up by OUR key (native lookup, or replay of the
  frozen request). It never throws: a lookup that hangs, errors or gets a 5xx is `unknown` and is never
  treated as a failure, never `not_found`, never `rejected`. A casino B ticket still `PENDING` is `pending`.
- Refund rule for the callers (the store area): a refund is allowed only after `rejected`, or after
  `not_found` on a lookup made after the issue deadline. It is never allowed after `unknown`.

Registry entries must declare
`recoveryMode` and `issueDeadlineMs` (bounds 60 s to 7 days); `register()` throws otherwise, and on a
duplicate type. The contract suite (`adapters.contract.test.ts`) enumerates the registry; an adapter
without a profile there fails it.

**3.4 What the store area needs from the port (coordinator decision D-12, review R2-1).** All of it is in
`packages/contracts/src/casino-adapter.ts`, so the store area builds against types, not wiring of its own:

- _Adapter registry per tenant._ `CasinoRewardPorts.forTenant(tenantId, {sandbox}) -> {port, info:
{recovery_mode, issue_deadline_ms, sandbox}} | undefined`, implemented by `createTenantCasinoPorts({integrations,
registry, transport})` (`integrations/tenant-ports.ts`). It resolves the adapter type and the settings
  from the tenant's integration credentials (`TenantIntegration.reward_api` =
  `CasinoRewardApiConfig {base_url, api_key?, sandbox_base_url?, sandbox_api_key?, issue_deadline_ms?}`,
  `TenantIntegrationPort.lookupById`). `undefined` for an unknown or suspended tenant, an unknown adapter
  type, no reward API settings, and sandbox without `sandbox_base_url` (the production adapter is never the
  sandbox fallback). A failing integration lookup rejects (identity down is not "no adapter": the caller
  retries, it does not refund).
- _The casino player id comes from the mapping._ `RewardRequestBuilder.build({tenantId, userId, reward,
sandbox})` (`createRewardRequestBuilder({players})`, `CasinoPlayerPort.externalPlayerId(tenantId, userId)`)
  reads the identity player mapping (the only place the raw id lives, MIO-107); no mapping row (erased) gives
  `undefined`, never a guess from the user id. The request is frozen on the order by the store area.
- _Issue deadline._ `info.issue_deadline_ms` is the tenant override, else the adapter type default
  (`AdapterEntry.issueDeadlineMs`). `not_found` from a status lookup is final only that long after the first
  issue attempt; before it, it can be a casino that has not seen the request, and the store area must keep
  polling. Refund-after-`not_found` stays the caller's rule (above).
- _Sandbox flag._ `RewardRequest.sandbox` is mandatory (no default). An adapter instance knows its
  environment (`AdapterConfig.sandbox`) and answers `rejected{reason:'sandbox_mismatch'}` before any I/O for
  a request of the other environment, in both directions; the sandbox port talks to the sandbox endpoint and
  key only. Metering reads the same flag from the order (L2/L4 spec).
- _Caution for callers._ On an `idempotent_replay` adapter `getRewardStatus` re-sends the issue, so it can
  issue the reward: call it only while the coins are held.

**Simulator** (`apps/casino-sim/src/server.ts`, `buildServer({deliver?, faultsEnabled?})`):
`POST /casino-{a|b}/__deposit {target_url, secret, player_id, amount_minor, currency?, event_id?, status?}`
sends a signed webhook through `deliver`. Control routes exist only when `faultsEnabled` (env
`SIM_FAULTS=1`, never published outside the compose network): `POST /__faults {casino, kind, times?,
player_id?, delay_ms?, copies?}`, `POST /__reset` (clears faults and issued), `GET /__issued?casino=`
(`[{key, player_id, reference, reward}]`), `POST /casino-b/__settle` (PENDING -> DONE/FAILED). Fault kinds:
`timeout` (effect recorded, reply after `delay_ms`), `dropReply` (effect recorded, socket destroyed),
`error500` (no effect), `reject` (final rejection, no effect), `slow` (delay then normal),
`duplicateDelivery` (`copies` identical webhooks), `outOfOrder` (the next two deposits are delivered
reversed). Faults apply to the next `times` matching calls (default 1), optionally for one `player_id`.
The existing `/casino-*/v1/wallet/credit` routes are untouched.

## 4. Ports (src/integrations/ports.ts, src/model/repositories.ts)

`TENANT_INTEGRATIONS.lookup(slug) | lookupById(tenantId) -> TenantIntegration` (identity's contract type, X-7:
`{tenant_id, platform, status, environment, webhook_secrets[1..2], player_hash_key, reward_api?}`; identity is
the source through `INTERNAL_ROUTES.integrationBySlug` and `.integration`; `INGEST_STATIC_TENANTS` JSON in dev,
section 10), `TENANT_CASINO_PORTS`, `CASINO_PLAYERS` (section 3.4, backed by identity's `INTERNAL_ROUTES.playerLink`,
X-8; a 404 is `undefined`, an outage is an error), `CLOCK`, `ADAPTER_REGISTRY`,
`PLAYER_DIRECTORY.resolveOrCreate(tenant, source, externalPlayerId) -> user_id` (identity writes the
mapping), `InboundEventsRepository`, `RulesRepository`, `SpinCreditsRepository`, `WheelsRepository`,
`SpinsRepository`, `SEEDS`. Services receive a `Tx` from `Db`; repositories own all SQL.
`SEEDS` has `current(tenantId) -> {version, seed}` and `seed(tenantId, version) -> string` (throws for an
unknown version): a spin stored under an older seed version is recomputed with `seed(tenant, stored
version)` after a rotation (MIO-063 recompute, MIO-069 audit). The real implementation is
`createSeedProvider(store: SeedStore)` in `model/seeds.ts` over a versioned `SeedStore {versions(tenant),
get(tenant, version)}` (env in dev); `current` is the highest version, `seed` reads exactly the version asked
for, an unknown version or tenant throws, and a version added to the store becomes current without a restart
(R2-3: pinned by `model/seeds.test.ts`, and `spin.service.test.ts` runs the rotation test through this real
provider rather than test-owned arithmetic). The inbound row stores `external_player_hmac` (section 10), not
the raw casino player id.

## 5. Ingestion order of checks (`IngestionService`, `IngestController`)

slug lookup (404) -> signature with each active secret (401: `signature_missing|signature_invalid|stale`)
-> tenant `suspended` (402) -> parse (400/422) -> ignored (200) -> one `tenantTx`: `insertIfAbsent`, and
`Db.publish(tx, deposit.confirmed)` only if inserted. Signature precedes parse and the suspended check, so
a stranger learns nothing about schemas or tenant state. The route is `@Public()` and reads the raw string
body (`registerRawJsonParser` swaps Fastify's JSON parser for a string parser on this app; the service
`JSON.parse`s after verification). Rotation: any of the (at most two) secrets may verify. Rejections log
reason code and slug, never the body, signature or secret.

## 6. Rules (`services/rules.engine.ts`)

`evaluateRules(rules, event, priorGrants) -> {rule_id, rule_version, wheel_id, spins}[]`, pure. A rule
version applies when `active_from <= occurred_at < active_to` (null = open) and the conditions hold
(`amount_minor >= min_amount_minor`, optional currency). Per `rule_id`, only the HIGHEST version active
at `occurred_at` fires, so a v2 published without closing v1 never double-grants; the result carries that
version's number. `max_grants_per_player` caps how many times a rule fires for one player
(`priorGrants[rule_id] >= cap` -> none); `SpinCreditsService` passes `priorGrantCounts(tx, user_id)` of the
identity-resolved player. The cap is best effort under concurrency: two deposits of one player processed
in parallel can both read the count before either inserts; only the sequential case is pinned. Rules are
zod data (`RuleDefinition`), no expression evaluation.

## 7. Spin credits (`services/spin-credits.service.ts`)

Per grant, rows `seq = 0..spins-1` keyed `(tenant_id, source_event_id = inbound_event_id, rule_id, seq)`;
`grant` is `ON CONFLICT DO NOTHING RETURNING`, and `spin.granted` is published only for returned rows.
`user_id` comes only from `PLAYER_DIRECTORY`. All in the inbox transaction.

Consume (`SpinCreditsRepository.consume`) takes exactly ONE credit, on both paths (with and without
`credit_id`), and `user_id` is in the statement on both:
`UPDATE spin_credits SET status='used', used_at=now() WHERE id = (SELECT id FROM spin_credits WHERE
tenant_id=$1 AND user_id=$2 AND status='available' [AND id=$3] ORDER BY created_at, id FOR UPDATE SKIP
LOCKED LIMIT 1) AND status='available' RETURNING *`. Without `LIMIT 1` one spin would use all of the
player's credits (pinned: INV-SPIN-ONE-PER-REQUEST-DB). `SKIP LOCKED` is a throughput choice, not a pinned
invariant (R2-4): the earlier claim that dropping it gives fewer than 3 winners for "3 credits, 50 parallel
requests" (MIO-141) is withdrawn. It was measured on the compose Postgres, 30 of 30 runs gave 3 winners and
0 credits left with and without it, at transaction holds of 0, 5 and 20 ms, because under READ COMMITTED a
waiter re-checks the row after the lock and moves on. No test here can catch its removal, so none claims to;
a test could only assert latency or "no 409 while a credit is still free under a forced lock hold", which is
timing and is not added. `findOwn` runs only after `consume` returned nothing, to tell 404 from 409;
ownership must hold without it. `countAvailable` (for `GET /v1/me/spins`) is a plain `count(*)` with
`user_id` and `status='available'`.

## 8. Wheel (`services/wheel.ts`, `services/spin.service.ts`)

Algorithm pinned in `wheel.test.ts` header: `hmac = HMAC-SHA256(seed, spinId)` hex; `roll` = first 6
bytes; `pick = floor(roll * total / 2^48)`; first segment with cumulative weight `> pick`. `selectSegment`
re-validates the table (positive integer weights, at least one segment, total <= 1,000,000) and throws on
a corrupt one. Reward tables are immutable versions; the spin stores `seed_version`, `table_version`,
`hmac`, `segment_index`. `GET /v1/wheel/:wheelId` returns `PublicWheel` (labels only); `GET /v1/wheel` returns the
tenant's active wheel as the same `PublicWheel` (W-2: the widget does not know the id; pinned by
`spin.controller.test.ts`). `SpinService.spin({idempotencyKey, creditId?, sandbox?})` gets `sandbox: true` from the
`sbx` claim of the verified token (INV-SPIN-SANDBOX-CLAIM) and writes it to the envelope of `spin.completed`
(INV-SPIN-SANDBOX); it is not a body field (422). `SpinService.spin`
runs in the tenant context with the principal as the player; `SpinService.wheel(wheelId)` builds the public
view with `toPublicWheel` from the stored table (404 for an unknown wheel), and the controller parses
whatever the service returns with `PublicWheel` (strict): a weight-bearing object is a 500, never a
response. Seeds live in the `SEEDS` provider (env in dev), never in responses or logs; the spin uses
`SEEDS.current` and stores that version, an audit uses `SEEDS.seed(tenant, stored version)`. Rate limits,
seed rotation schedule and the audit script (MIO-069) are Stage B follow-on items, see section 12.

## 9. Errors

Ingest: `signature_missing|signature_invalid|stale` 401, `malformed_json` 400, `schema_invalid` 422,
`unknown_tenant` 404, `tenant_suspended` 402; body `{message, code}` (`IngestErrorBody`). Spin: 422 on any
schema failure (engagement controllers parse with zod and answer 422, not the 400 of `parseInput`), 400 on
a missing `Idempotency-Key`, 401 without a valid token (the tenant and the player come only from the
verified access token of the shared service-kit entry point, never from headers, D-4), 404 not the player's
credit, 409 with body code `no_credit` (nothing to spin) or `in_progress` (the same key still running,
retryable), 422 the same key with a changed body (D-3). The 409 code is part of the contract
(`SpinConflictBody`); a client must not infer it from the message.
Contracts: `packages/contracts/src/ingest.ts`, events `engagement.deposit.confirmed` v1 and
`engagement.spin.granted` v1 (registered; `engagement.spin.completed` v1 already exists and is reused,
with the optional `table_version` added by D-1), and `packages/contracts/src/casino-adapter.ts` (the
single reward port, D-2).

## 10. Storage and dev configuration (migration is Stage B)

Tables, all `tenant_id` + `ENABLE/FORCE RLS` via `enableTenantRls`: `inbound_events(id uuid, tenant_id,
source, external_event_id, external_player_hmac, amount_minor bigint, currency, occurred_at, received_at,
UNIQUE(tenant_id, source, external_event_id))` (D-12: `external_player_hmac` = hex HMAC-SHA256 with the
tenant's `player_hash_key` over `${source}\n${external_player_id}`; there is no raw `external_player_id`
column, so MIO-107's "no table outside identity has an external player id column" holds and the erasure
model deletes only the identity mapping row; dedupe and audit work on the hash)`; `rules(tenant_id, rule_id, version, definition jsonb, UNIQUE(tenant_id, rule_id, version))`;
`reward_tables(tenant_id, wheel_id, version, definition jsonb, UNIQUE(tenant_id, wheel_id, version))`;
`spin_credits(id, tenant_id, user_id, wheel_id, source_event_id, rule_id, rule_version, seq, status,
used_at, created_at, UNIQUE(tenant_id, source_event_id, rule_id, seq))`;
`spins(id, tenant_id, user_id, credit_id, operation_id, seed_version, table_version, hmac, segment_index,
segment_label, reward_coins, UNIQUE(tenant_id, user_id, operation_id))`. Two roles (D-12, the payments
pattern): `engagement`is the OWNER and runs the migrations;`engagement_app`is the RUNTIME role the service
connects with.`engagement_app`is not superuser, has no BYPASSRLS, CREATEROLE or CREATEDB, owns none of the
tables, and has no UPDATE on anything but`spin_credits(status, used_at)`, and no DELETE on `reward_tables`,
`rules`, `spins`, `inbound_events`(the fairness and audit record is immutable). A trigger on`spin_credits`rejects`used -> available` (no way back). Because the app role is not the owner it cannot DROP or DISABLE
the trigger, DISABLE or un-FORCE row level security, DROP a table, or grant itself a privilege. The
bootstrap (`docker/postgres/init.sh`, password `ENGAGEMENT_APP_DB_PASSWORD`, dev default
`engagement-app-dev`) creates the role and the migration grants it exactly this. `tests/compose` checks all
of this in the catalog and by attempting it (`INV-ENGAGEMENT-SCHEMA-DB`, `INV-ENGAGEMENT-ROLE-DB`), and
every compose DB call except the catalog checks and the fault trigger runs as `engagement_app`.
Closed (X-1, D-12): the `engagement.deposit.confirmed`payload carries the resolved internal`player_id`and never
the raw`external_player_id`(strict schema; the player is resolved through identity before the outbox write), so`INV-ING-NO-RAW-ID-DB` scans EVERY table, the outbox included.
Dev compose env for engagement (so`ingest.compose.test.ts`runs without identity):`INGEST_STATIC_TENANTS`=`{"ingest-t1":{"tenant_id":"0190a1b2-c3d4-4e5f-8a6b-1000000000a1","platform":"casino-a","status":"active","environment":"production",
"webhook_secrets":["dev-ingest-secret-1"],"player_hash_key":"dev-hash-key-1"},"ingest-t2":{... "...a2",
"dev-ingest-secret-2", "dev-hash-key-2"}}`. Spin and me/spins calls in compose carry a real player token:
`tests/compose/src/player-session.ts` signs up an operator, issues a casino key and launches a player
through the identity service (`@ex-mio/service-kit/testing`signs the launch token), so those tests run
in their own identity tenants and need identity in the stack,`WHEEL_SEEDS={"1":"dev-wheel-seed-1"}`. These are development-only values.

## 11. Invariants, backlog criteria, choke points, tests

| Invariant (test name prefix)                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Backlog criterion                                           | Choke point                                                                                     | Test file                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| INV-ADAPTER-SIG-ACCEPT/REJECT, INV-ADAPTER-WINDOW                                                                                                                                                                                                                                                                                                                                                                                                                                           | MIO-054 wrong/stale signature                               | `CasinoAdapter.verifySignature`                                                                 | `integrations/adapters.contract.test.ts`                                              |
| INV-ADAPTER-INT-MINOR, -SCHEMA, -MAPPING, -IGNORED                                                                                                                                                                                                                                                                                                                                                                                                                                          | MIO-050 integer amounts; MIO-147                            | `CasinoAdapter.parseEvent`                                                                      | same                                                                                  |
| INV-ADAPTER-LOST-REPLY, -TIMEOUT-UNKNOWN, -FINAL-REJECTION, -ISSUE, -STATUS-UNKNOWN-KEY                                                                                                                                                                                                                                                                                                                                                                                                     | MIO-050 effect done / reply lost; MIO-057                   | `issueReward`, `getRewardStatus`                                                                | same                                                                                  |
| INV-ADAPTER-STATUS-UNKNOWN (lookup timeout, throw, 5xx is `unknown`), INV-ADAPTER-PENDING (casino B PENDING; casino A never pending)                                                                                                                                                                                                                                                                                                                                                        | MIO-057 timeout is not failure; MIO-050; D-2                | `getRewardStatus`, `issueReward`                                                                | same                                                                                  |
| INV-PORT-ISSUE-RESULT, -STATUS-RESULT, -REQUEST, INV-SPIN-EVENT-CONTRACT (schemas; green at Stage A by design)                                                                                                                                                                                                                                                                                                                                                                              | D-2 one port; D-1 `spin.completed`                          | zod in `casino-adapter.ts`, `events.ts`                                                         | `packages/contracts/src/casino-adapter.contracts.test.ts`                             |
| INV-REGISTRY-RECOVERY-MODE, -DEFAULTS                                                                                                                                                                                                                                                                                                                                                                                                                                                       | MIO-050, MIO-057 registry test                              | `AdapterRegistry.register`                                                                      | same                                                                                  |
| INV-ING-SIG, -CROSS-TENANT, -STALE, -SIG-FIRST, -VALIDATION, -TENANT-LOOKUP, -ROTATION, -NO-SECRET-LEAK                                                                                                                                                                                                                                                                                                                                                                                     | MIO-054, MIO-147                                            | `IngestionService` (check order)                                                                | `controllers/ingest.controller.test.ts`                                               |
| INV-ING-IGNORED, -DEDUPE, -DEDUPE-PARALLEL, -DEDUPE-PER-TENANT, -ATOMIC                                                                                                                                                                                                                                                                                                                                                                                                                     | MIO-055, MIO-056, MIO-140                                   | `IngestionService` (publish iff inserted, one tx)                                               | same                                                                                  |
| INV-ING-DEDUPE-DB, -DEDUPE-TENANT-DB, -CROSS-TENANT-DB                                                                                                                                                                                                                                                                                                                                                                                                                                      | MIO-055 ten parallel; MIO-140                               | UNIQUE index, outbox in tx                                                                      | `tests/compose/src/ingest.compose.test.ts`                                            |
| INV-RULE-THRESHOLD, -CONDITIONS, -WINDOW, -VERSION-AT-TIME, -ONE-VERSION (overlapping versions never double-grant), -CAP, -MULTI, -PURE                                                                                                                                                                                                                                                                                                                                                     | MIO-060                                                     | `evaluateRules`                                                                                 | `services/rules.engine.test.ts`                                                       |
| INV-RULE-SCHEMA, INV-ING-INT-AMOUNT, INV-EVT-REGISTERED, INV-WHEEL-WEIGHTS, INV-SPIN-NO-CHOICE, INV-WHEEL-PUBLIC-NO-WEIGHTS (schemas; green at Stage A by design)                                                                                                                                                                                                                                                                                                                           | MIO-060 422; MIO-062 422; MIO-063 extra field; MIO-151      | zod contracts                                                                                   | `packages/contracts/src/ingest.contracts.test.ts`                                     |
| INV-CRED-ONCE, -PLAYER-MAPPED, -THRESHOLD, -ATOMIC, -POISON, -CAP-WIRED (priorGrantCounts of the resolved player reaches the engine)                                                                                                                                                                                                                                                                                                                                                        | MIO-061, MIO-060 cap                                        | `SpinCreditsService`, `grant` key                                                               | `services/spin-credits.service.test.ts`                                               |
| INV-WHEEL-DETERMINISTIC, -STORES-VERSIONS, -DISTRIBUTION (`WHEEL_DIST_N`, default 1,000,000), -WEIGHTS-SUM, -REJECTS-BAD-TABLE, -PUBLIC-NO-WEIGHTS, INV-SPIN-RECOMPUTE-AFTER-ROTATION (pure)                                                                                                                                                                                                                                                                                                | MIO-063 recompute, 1M spins within 0.5 pp; MIO-062; MIO-069 | `selectSegment`, `toPublicWheel`                                                                | `services/wheel.test.ts`                                                              |
| INV-SPIN-ONE-WINNER, -OWNERSHIP (with and without credit_id), -NO-CREDIT, -SERVER-AUTHORITY, -ATOMIC, -EVENT (incl. table_version), -NO-CREDIT-CALL (no HTTP), -NOTHING, -REPLAY, -REPLAY-SCOPED, -REPLAY-PARALLEL (one spin, 409 in flight), -REPLAY-BODY (422), INV-WHEEL-PUBLIC-NO-WEIGHTS (service), INV-SPIN-RECOMPUTE-AFTER-ROTATION (via `SEEDS.seed`)                                                                                                                               | MIO-063, MIO-064, MIO-141, MIO-154; D-1, D-3                | `SpinService` + `consume()`                                                                     | `services/spin.service.test.ts`                                                       |
| INV-SPIN-NO-CHOICE, -PRINCIPAL-ONLY, INV-WHEEL-PUBLIC-NO-WEIGHTS (HTTP; service mock returns weights, expect 500 and no leak)                                                                                                                                                                                                                                                                                                                                                               | MIO-063, MIO-151                                            | `SpinController` zod, output parse                                                              | `controllers/spin.controller.test.ts`                                                 |
| INV-SPIN-ONE-PER-REQUEST-DB (one credit used without credit_id), INV-SPIN-ONE-WINNER-DB (1 credit, 50 parallel), -DB-3 (3 credits, 50 parallel: exactly 3), INV-SPIN-OWNERSHIP-DB (credit_id), -NO-CREDIT-ID, INV-SPIN-REPLAY-PARALLEL-DB (same key x20: one spin, one outbox row, replay, 422), INV-ING-ATOMIC-DB (outbox failure rolls the inbound row back), INV-ENGAGEMENT-SCHEMA-DB (UNIQUEs, no UPDATE/DELETE on immutable tables, used never available)                              | MIO-141 50 parallel; MIO-154; MIO-055; D-3                  | conditional UPDATE with `user_id`, `LIMIT 1`, one tx, catalog (SKIP LOCKED is not pinned, R2-4) | `tests/compose/src/ingest.compose.test.ts`                                            |
| INV-PORT-SANDBOX-FLAG (mandatory), INV-PORT-RESOLVED-INFO (recovery mode, deadline in bounds, environment), INV-PORT-TENANT-CONFIG (per tenant reward API settings, sandbox endpoint never derived), INV-SPIN-RESPONSE-INDEX (`segment_index`), INV-ME-SPINS-SHAPE, INV-SPIN-CONFLICT-CODE (`in_progress`, `no_credit`) (schemas; green at Stage A by design)                                                                                                                               | D-12 R2-1; coordinator (web wheel, me/spins); D-3 R2-5      | zod in `casino-adapter.ts`, `ingest.ts`                                                         | `packages/contracts/src/casino-adapter.contracts.test.ts`, `ingest.contracts.test.ts` |
| INV-REGISTRY-ISSUE-DEADLINE (no deadline, no registration), INV-ADAPTER-SANDBOX-MISMATCH (both directions, no I/O)                                                                                                                                                                                                                                                                                                                                                                          | D-12, D-2 not_found is final only after the deadline        | `AdapterRegistry.register`, every adapter                                                       | `integrations/adapters.contract.test.ts`                                              |
| INV-REG-PER-TENANT (type, URL, credentials per tenant), INV-REG-DEADLINE (override, else default), INV-REG-SANDBOX (sandbox endpoint only, no production fallback), INV-REG-ABSENT (absent is `undefined`, a failing lookup rejects), INV-REQ-MAPPING (casino player id from the mapping, none gives `undefined`)                                                                                                                                                                           | D-12 R2-1                                                   | `createTenantCasinoPorts`, `createRewardRequestBuilder`                                         | `integrations/tenant-ports.test.ts`                                                   |
| INV-ING-PLAYER-HMAC (row holds the tenant-keyed HMAC, no raw id field; also pins `${source}\n${id}`)                                                                                                                                                                                                                                                                                                                                                                                        | D-12, MIO-107                                               | `IngestionService`                                                                              | `controllers/ingest.controller.test.ts`                                               |
| INV-ING-NO-RAW-ID-DB (no raw-id column, value is the HMAC, raw id in no table, the outbox included (X-1); the deposit event carries `player_id` only), INV-ENGAGEMENT-ROLE-DB (`engagement_app` owns nothing, cannot drop or disable the trigger, disable or un-force RLS, drop a table or grant itself UPDATE; catalog unchanged afterwards), INV-ME-SPINS-DB (own count, tenant-scoped, 401 without a token), INV-SPIN-CONFLICT-CODE-DB (inside the ONE-WINNER and REPLAY-PARALLEL tests) | D-12 R2-6, R2-7; coordinator; R2-5                          | migration, roles, `SpinCreditsRepository.countAvailable`                                        | `tests/compose/src/ingest.compose.test.ts`                                            |
| INV-SEED-BY-VERSION, -CURRENT-IS-HIGHEST, -UNKNOWN-THROWS, -PER-TENANT, -ROTATION-LIVE (the real `SeedProvider` over a versioned store; INV-SPIN-RECOMPUTE-AFTER-ROTATION now reads through it)                                                                                                                                                                                                                                                                                             | MIO-063 recompute, MIO-069; R2-3                            | `createSeedProvider`                                                                            | `model/seeds.test.ts`, `services/spin.service.test.ts`                                |
| INV-SPIN-CONFLICT-CODE (the 409 body code in ONE-WINNER, NO-CREDIT, OWNERSHIP, REPLAY-PARALLEL), INV-SPIN-SERVER-AUTHORITY (also `segment_index`, replay keeps it), INV-ME-SPINS (`availableSpins`: own, available only, user from the principal)                                                                                                                                                                                                                                           | R2-5; coordinator                                           | `SpinService`                                                                                   | `services/spin.service.test.ts`                                                       |
| INV-ME-SPINS (token only, no user input, strict output), INV-SPIN-PRINCIPAL-ONLY (tenant and principal from the verified token, no header)                                                                                                                                                                                                                                                                                                                                                  | coordinator; D-4 R2-2                                       | `SpinController`, `ServiceAuthModule`                                                           | `controllers/spin.controller.test.ts`                                                 |
| SIM-\*                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | MIO-051, 052, 053                                           | simulator                                                                                       | `apps/casino-sim/src/casinos.test.ts`                                                 |

## 12. Out of scope here

Redemption saga and bonus store (MIO-065..068, the store area; it imports the port from
`packages/contracts/src/casino-adapter.ts`); the payments side of `spin.completed` (L2: the inbox
consumer that credits coins under the ledger key `(spin_award, <spin_id>)`, and MIO-064 criteria such as five redeliveries
credit once and payments down means retry from the outbox; the L2 spec and tests must follow D-1, this
area only emits the event); the real identity client behind `TENANT_INTEGRATIONS` and
`PLAYER_DIRECTORY` (L1; the dev static config stands in); operator CRUD APIs for rules and tables, rate
limiting, seed rotation schedule and the audit script (MIO-069; its prerequisite `SEEDS.seed(version)` is
in scope), websocket pushes of `spin.granted` (L5/realtime), `docs/how-to/where-to-change.md` (adding a casino).

Deferred with a named reason: MIO-151 "spin with an operator or platform token is 403" waits until L1
issues a principal kind (foundation tenancy has none). `GET /v1/me/spins` is no longer deferred: it is in
section 2 and pinned. Authentication of every engagement test: tokens from `@ex-mio/service-kit/testing`
(taken from the identity area with `packages/contracts/src/identity.ts`) through
`apps/engagement/src/testing/auth.fixture.ts` for in-process tests, and a real identity launch for compose;
no `x-tenant-id` or `x-principal-id` header is used (R2-2). Not changed here: the foundation test
`apps/engagement/src/projections.test.ts` still uses `TenancyModule` and a header; the identity spec
lists it among the files its Stage B rewrites, so editing it here would collide with that. Backlog doc fix, not a test change: MIO-141 line 21 should read "50 parallel requests with the
same key: one 201, the others 201 with the same spin or 409 `in progress`; a retry after completion returns
the same spin; one credit consumed."

Stage A also adds only type-level stubs: `integrations/adapter.ts`, `integrations/ports.ts`,
`model/repositories.ts` (incl. `SeedStore`, `countAvailable`), and the `DeliverFn`/option types in `casino-sim/src/server.ts`, plus the
contract `packages/contracts/src/casino-adapter.ts` (schemas and the port interface, no behaviour).
