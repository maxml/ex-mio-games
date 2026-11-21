# Spec: engagement store (bonus catalog and redemption saga)

Backlog: MIO-065, MIO-066, MIO-067, MIO-068, MIO-142 to MIO-145 (store and saga parts). Binding coordinator
decisions: D-1 (the payments service owns every coin operation; the redemption reserve is a synchronous internal
API), D-2 (one casino port), D-3 (same key in parallel), D-8 (saga gaps), D-9 (payments idempotency and contract
owners). The words "must" and "never" are checked by a test named in §3.

## 1. Behaviour

A tenant's operator keeps a catalog of items (price in whole coins, a reward mapping in canonical form, optional
stock, optional per-player limit, active flag). A player redeems an item with `POST /v1/redemptions`.

The redemption is a saga over two databases (engagement owns stock and limit, payments owns coins) and one
external system (the casino, reached through the shared adapter port):

1. **Order** (engagement, one transaction): conditional decrement of stock and per-player limit, freeze price and
   reward mapping, insert `REQUESTED` with `next_attempt_at = now + 30 s`. No command is written to a bus.
2. **Reserve** (payments, synchronous, inline in the POST): `POST /internal/v1/coins/reserve`, key `hold:{id}`,
   `reserve_id = redemption id`. Answer `ok` with the frozen amount -> `RESERVED`. `409 insufficient_funds` ->
   `REJECTED_FUNDS`, the stock reservation is released, and **the POST answers 409 `insufficient_funds`** (D-8:
   the player sees it at once). Any other refusal, or an `ok` with another amount than the frozen price ->
   `NEEDS_REVIEW` (`reserve_refused` / `hold_amount_mismatch`); nothing is released and an alert is raised. A
   timeout or transport error leaves `REQUESTED`: the player gets 202, and the sweeper repeats the same call with
   the same key after the 30 s grace. No casino call happens before the reserve answered `ok`.
3. **Issue** (the sweeper, never inline in the POST): `RESERVED -> ISSUING` is committed (attempt counted, 60 s
   lease) **before** the adapter is called, with key `redeem:{id}` and the request built from the FROZEN order.
   Result `issued{external_ref}` -> `ISSUED`; `rejected{reason}` -> `REJECTED`; `pending{external_ref?}` ->
   `UNKNOWN` with the ref stored, no further attempt consumed; `unknown` or a thrown error -> `UNKNOWN`, next
   attempt at `now + backoff`.
4. **Recovery** (the sweeper): for `UNKNOWN`, and for an `ISSUING` whose lease expired (a crash; it becomes
   `UNKNOWN` first, D3), call `getRewardStatus(redeem:{id}, request)` with the same frozen request. `issued` ->
   `ISSUED`; `rejected` -> `REJECTED`; `pending` or `unknown` -> reschedule (no attempt, no state change);
   `not_found` -> retry with the same key (`ISSUING`, attempts + 1, then the issue call) while attempts < 8. At 8
   attempts on `not_found` -> `NEEDS_REVIEW` `attempts_exhausted`. A streak older than 24 h (`unknown_since`)
   that did not end in a decision -> `NEEDS_REVIEW` `unknown_too_long` (also for a ticket that stays `pending`).
5. **Settle** (the sweeper): `ISSUED` -> `POST .../capture`, key `capture:{id}` -> `COMPLETED` (reservation
   committed). `REJECTED` -> `POST .../release`, key `release:{id}` -> `RELEASED` (reservation released: stock and
   limit are back). A transport error reschedules the same call. A refusal (`invalid_reserve_transition`,
   `reserve_not_found`) -> `NEEDS_REVIEW` `capture_refused` / `release_refused`: payments does not say which
   conflicting state it holds (D-9), so the reason is ours.
6. **Compensation after capture**: a casino report `revoked` on a `COMPLETED` redemption -> `POST .../refund`,
   key `refund:{id}`, then `REFUNDED`. A refusal -> `NEEDS_REVIEW` `refund_refused`. The refund is driven by the
   report; a failed call is repeated when the report is delivered again (reports have a delivery id).
7. **Release gate (D-2)**: coins go back to the player only after the casino answered `rejected`. Never after
   `unknown`, never after `pending`, never on the operator's word alone. The automatic path is stricter than D-2
   requires: `not_found` never releases, not even at exhaustion; it ends in `NEEDS_REVIEW` with the coins held.
   The only path that releases on `not_found` is the operator's `not_issued` (§8), and only for a lookup made at
   or after the issue deadline.
8. **Late and conflicting news** (`onCasinoReport`, refused payments calls) never moves coins: it moves the
   redemption to `NEEDS_REVIEW` with a reason and raises `engagement.redemption.needs_review`. `onCasinoReport`
   takes the delivery id of the report; the inbox row (`engagement.redemption-saga`, delivery id) is written in the
   same transaction as the state change.
9. **Operator** (owner/admin, audited reason in the history cause):
   - `resolveReview issued` -> `ISSUED`, then the normal capture follows. Refused (`illegal_transition`) for a
     review entered from `REQUESTED`: the casino was never asked.
   - `resolveReview not_issued` -> a fresh `getRewardStatus` first. `rejected` -> `REJECTED`, then the release
     follows. `not_found` from a lookup made at or after the **issue deadline** (`at` of the first `ISSUING`
     history row + 24 h) -> the same. Anything else (`unknown`, `pending`, `issued`, or `not_found` before the
     deadline) -> 409 `release_not_allowed`, nothing changes. A review entered from `REQUESTED` was never sent to
     the casino and needs no lookup.
   - `replay` (D-8, supersedes D1): allowed ONLY for a review entered from `UNKNOWN` (`attempts_exhausted`,
     `unknown_too_long`), i.e. while the coins are still held. It re-enters `UNKNOWN` with a fresh attempt budget.
     For a review entered from any other state (`RELEASED`, `REJECTED`, `ISSUED`, `COMPLETED`, `REQUESTED`)
     `apply` itself refuses it (409 `illegal_transition`): once the coins are released the reward can never be
     issued.
10. **Stock is returned exactly once** (D-8): `reservation: 'release'` acts only while the reservation is
    `reserved`; `commit` likewise. A second release through any path (RELEASED -> review -> `not_issued` ->
    release again) restores nothing. The choke point is the store's `apply`.

Sandbox: the `sandbox` flag of a redemption comes from the server-side request context (placeholder header
`x-sandbox` until identity issues key-derived claims), never from a body. A sandbox order is issued only through
the sandbox adapter, reserves only sandbox coins (the flag selects the sandbox ledger of payments; it is not a body
field), and every event of it carries `sandbox: true`. Redemptions are not metered: payments meters only
`engagement.spin.completed`, so the flag on redemption events has no reader today and is kept for the day one
exists. Lookup of a redemption includes the flag.

## 2. State tables

**Redemption** (the oracle is typed out in `apps/engagement/src/redemptions/testing/transition-oracle.ts`; the
exported `REDEMPTION_TRANSITIONS` must equal it row for row). 21 rows: the 19 rows of MIO-066, `NEEDS_REVIEW ->
UNKNOWN` (replay, guarded by history, see below) and `REQUESTED -> NEEDS_REVIEW`.

| From               | To                | Trigger                                                               | Effect in the same transaction                              |
| ------------------ | ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| REQUESTED          | RESERVED          | reserve `ok`, amount = frozen price                                   | `next_attempt_at = now`                                     |
| REQUESTED          | REJECTED_FUNDS    | reserve `409 insufficient_funds`                                      | release reservation, reason `insufficient_funds`            |
| REQUESTED          | NEEDS_REVIEW      | reserve amount mismatch / other refusal                               | reason `hold_amount_mismatch` / `reserve_refused`           |
| RESERVED           | ISSUING           | sweeper                                                               | attempts + 1, lease 60 s                                    |
| ISSUING            | ISSUED            | adapter `issued`                                                      | reference stored, `next_attempt_at = now`                   |
| ISSUING            | REJECTED          | adapter `rejected`                                                    | reason `casino_rejected:<reason>`, `next_attempt_at = now`  |
| ISSUING            | UNKNOWN           | adapter `unknown`/`pending`/throw, or lease expired                   | `next_attempt_at = now + backoff`; `unknown_since` set once |
| UNKNOWN            | ISSUED / REJECTED | lookup `issued` / `rejected`                                          | as above                                                    |
| UNKNOWN            | ISSUING           | lookup `not_found`, attempts < 8                                      | attempts + 1, same key                                      |
| UNKNOWN            | NEEDS_REVIEW      | attempts = 8 on `not_found`, or age >= 24 h                           | reason `attempts_exhausted` / `unknown_too_long`            |
| ISSUED             | COMPLETED         | capture `ok`                                                          | commit reservation                                          |
| REJECTED           | RELEASED          | release `ok`                                                          | release reservation (once)                                  |
| COMPLETED          | REFUNDED          | report `revoked`, refund `ok`                                         | none                                                        |
| REJECTED, RELEASED | NEEDS_REVIEW      | late success report                                                   | reason `late_success_after_release`                         |
| ISSUED, COMPLETED  | NEEDS_REVIEW      | late rejection report / capture refused / refund refused              | `late_rejection_after_complete` / `capture_refused` / ...   |
| REJECTED           | NEEDS_REVIEW      | release refused                                                       | `release_refused`                                           |
| NEEDS_REVIEW       | ISSUED / REJECTED | operator resolve (REJECTED only through the release gate)             | as above                                                    |
| NEEDS_REVIEW       | UNKNOWN           | `replay`, only if the latest entry into NEEDS_REVIEW was from UNKNOWN | attempts reset, `unknown_since` set                         |

Every other pair is refused by `assertTransition`. A duplicate trigger (same delivery id, or a state that is
already past it) applies nothing. `unknown_since` is set when UNKNOWN is entered and stays through `UNKNOWN ->
ISSUING -> UNKNOWN` (the 24 h age counts from the first one); it is cleared on `ISSUED`, `REJECTED`,
`NEEDS_REVIEW`.

**Reserve (payments)** is the payments service's: `reserved -> captured | released`, `captured -> refunded`.
Capture, release and refund are idempotent by the state of the reserve: a repeat of an applied transition returns
the stored result with any key; only a conflicting transition is refused (409 `invalid_reserve_transition`)
(D-9). The tests carry a fake of its HTTP table (`testing/world.ts` `FakePayments`); the payments service owns the
real one.

## 3. Invariants, choke points, tests

| Id                  | Invariant (backlog criterion)                                                                                                                                                                              | Choke point                                                                               | Tests                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| I-STATE-1           | Only table transitions exist; code table = spec table (MIO-067)                                                                                                                                            | `model/redemption-state.ts` `assertTransition`, called by `RedemptionStore.apply`         | `model/redemption-state.test.ts`; store contract 'apply rejects a pair outside the table'                             |
| I-ORDER-1           | One order per (tenant, player, operation key); another item under the same key is `idempotency_key_reused` (MIO-142)                                                                                       | `RedemptionStore.placeOrder`                                                              | store contract (3 tests); saga `I-ORDER-1`; compose `I-ORDER-1`, `I-ORDER-1b`                                         |
| I-ORDER-2           | Stock and limit change only by conditional update; never below zero under 50 parallel reservations (MIO-065, MIO-066)                                                                                      | `placeOrder` (conditional `UPDATE ... WHERE stock > 0`)                                   | store contract (50 parallel, last item, limit); saga `I-ORDER-2/3`; compose `I-ORDER-2`                               |
| I-ORDER-4           | Price and reward mapping frozen on the order (MIO-066)                                                                                                                                                     | `placeOrder` copies them; the saga reads only the record                                  | store contract 'frozen'; saga `I-ORDER-4`                                                                             |
| I-ORDER-5           | A reserve answering another amount than the price does not strand money: `NEEDS_REVIEW` + alert                                                                                                            | saga reserve step; `apply` table row `REQUESTED -> NEEDS_REVIEW`                          | saga `I-ORDER-5`; store contract (history, events)                                                                    |
| I-RESERVE-1,2       | The reserve is synchronous with a durable retry: a transport error leaves `REQUESTED`, the sweeper repeats it with the same key; other refusals go to review                                               | saga reserve step; `dueForSweep` (REQUESTED after the grace)                              | saga `I-RESERVE-1,2`; store contract 'placeOrder ... grace', 'dueForSweep'                                            |
| I-OUTCOME-1..4      | Success: one capture, one reward; funds: **POST 409**, stock back, no casino call; rejection: REJECTED then RELEASED; RELEASED only after payments answered                                                | saga + `apply`                                                                            | saga `I-OUTCOME-1..4`; compose `I-OUTCOME-2`                                                                          |
| I-AMBIGUOUS-1..7    | Timeout is `UNKNOWN`, coins held; recovery by OUR key, same key on retry, 8 attempts, 24 h, unknown code retryable, restart resumes (MIO-068, MIO-143)                                                     | saga `issue`/`inquire`; `services/backoff.ts`                                             | saga `I-AMBIGUOUS-1..7`; `services/backoff.test.ts`                                                                   |
| I-PENDING-1..4      | `pending` is waiting, not failing: ref stored, no attempt consumed, never re-issued, never released, ages out at 24 h; casino B recovered by replay of the frozen request (D-2)                            | saga `issue`/`inquire`                                                                    | saga `I-PENDING-1..4`                                                                                                 |
| I-RELEASE-GATE-1..4 | Coins go back only after `rejected` (or the operator path on a late `not_found`); never after `unknown`, `pending`, or the operator's word alone (D-2)                                                     | the saga's single payments-release call site; `resolveReview` fresh lookup                | saga `I-RELEASE-GATE-1..4`                                                                                            |
| I-DEDUPE-1,2,3      | Two sweepers do not both issue; duplicate reports apply once; an old report redelivered after the operator resolved its review applies nothing (inbox, not only the state guard)                           | `apply` with `expectFrom` and `dedupe`                                                    | saga `I-DEDUPE-1..3`; store contract 'repeated event id ... legal again', '10 concurrent applies'                     |
| I-LATE-1..4         | Late/conflicting news goes to `NEEDS_REVIEW`, no coin movement, reader sees the reason (MIO-066, MIO-067)                                                                                                  | saga `onCasinoReport`, refused payments calls                                             | saga `I-LATE-1..4`                                                                                                    |
| I-STOCK-1           | Stock is returned exactly once through RELEASED -> review -> `not_issued` (D-8)                                                                                                                            | `apply`: release conditional on `reservation = reserved`                                  | saga `I-STOCK-1`; store contract 'exactly once through release, review and not_issued', 'a committed reservation ...' |
| I-REPLAY-1,2        | `replay` only for a review entered from UNKNOWN (D-8)                                                                                                                                                      | `apply` (history guard on `NEEDS_REVIEW -> UNKNOWN`), whoever calls it                    | saga `I-REPLAY-1,2`; store contract 'replay is refused unless ...' (4 origins + REQUESTED + latest entry)             |
| I-REFUND-1,2        | At most one refund per redemption (MIO-144); a refused refund goes to review                                                                                                                               | `apply` guard `expectFrom: COMPLETED`; payments by-state idempotency                      | saga `I-REFUND-1,2`                                                                                                   |
| I-REVIEW-1,2,3      | Only owner/admin resolve; the reason is audited; `issued` is refused for a review the casino never saw                                                                                                     | saga `resolveReview` + controller                                                         | saga `I-REVIEW-*`; controller `I-OPS-2`, `I-OPS-4`                                                                    |
| I-CRASH-1..8        | Killed at each durable boundary the run ends as the no-crash run, ONE effect in the casino and in payments, ledger conserved (MIO-066). The world places the kill on the ports; the saga has no crash hook | single-transaction `apply`; the sweeper; payments by-state idempotency                    | saga `I-CRASH-1..8`                                                                                                   |
| I-AUDIT             | The adapter is called only while the store row is ISSUING with its attempt already recorded (MIO-066 "attempt durable before the call")                                                                    | `apply` of `RESERVED -> ISSUING` before the call; checked from the store row at call time | `World.auditViolations()`, asserted `afterEach` in every saga test                                                    |
| I-ATOMIC-1          | A change that fails midway leaves nothing behind (state, history, stock, inbox, outbox)                                                                                                                    | `apply` is one transaction                                                                | store contract 'a change that fails midway ...' (both stores)                                                         |
| I-WORKQ-1           | The sweeper finds exactly the work: states, times, null = due, lease, grace                                                                                                                                | `dueForSweep` over the work queue maintained by `apply`/`placeOrder`                      | store contract 'dueForSweep', 'reschedule', 'attempts', 'unknownSince'                                                |
| I-OWN-1,2           | Player B cannot read A's redemption; lookup is `(tenant, player, sandbox, id)`; 404 not 403 (MIO-067, MIO-154)                                                                                             | `RedemptionStore.getOwn` + RLS; controller passes the caller's scope                      | store contract 'lookup'; controller `I-OWN-1`; compose `I-OWN-1/2`, `I-ISO-2`                                         |
| I-ISO-1             | A tenant never sees another tenant's items (MIO-065)                                                                                                                                                       | RLS on `store_items`                                                                      | compose `I-ISO-1`                                                                                                     |
| I-API-1..8          | Roles, price 422, validation before the service, error codes, **POST 409 `insufficient_funds`**                                                                                                            | controllers (zod + role guard + exception filter)                                         | `controllers/store.controllers.test.ts`                                                                               |
| I-VIEW-1,2,3        | Players see `pending` for `NEEDS_REVIEW` and never its reason; four public words; **the player sees `insufficient_funds`** on GET                                                                          | controller DTO mapper                                                                     | controller `I-VIEW-*`                                                                                                 |
| I-OPS-1..4          | Operator list and single GET (own tenant); resolve needs owner/admin; saga refusals have their HTTP codes                                                                                                  | controllers                                                                               | controller `I-OPS-*`                                                                                                  |
| I-SANDBOX-1,2,3     | Sandbox redemptions use only the sandbox adapter and the sandbox ledger, carry `sandbox` on every event, flag never from a body (MIO-092)                                                                  | saga adapter and coin call from the order's flag; `apply` stamps events                   | saga `I-SANDBOX-*`; controller `I-API-5`                                                                              |
| I-CONTRACT-1        | One casino port, one coin reserve: the store defines neither and registers no hold command or event (D-1, D-2, D-9)                                                                                        | `packages/contracts`                                                                      | `packages/contracts/src/store.contracts.test.ts`                                                                      |

## 4. Interfaces

`apps/engagement/src/redemptions/ports.ts` holds the stub types (frozen with the tests): `RedemptionStore`,
`StateChange`, `RedemptionRecord`, `StoreRejection`, `CoinsPort` (the HTTP client of the payments reserve),
`SagaDeps`, `RedemptionSaga`, `CasinoReport`, `Operator`, `Clock`. The casino port is
`packages/contracts/src/casino-adapter.ts` (`CasinoRewardPort`, `RewardRequest`, `IssueResult`, `RewardStatus`).

4.1 `RedemptionStore.apply` writes, in the same transaction as the state change: history row, counters, the
`engagement.redemption.status_changed` event on every change, plus `...issued` on entering `ISSUED` with a
reference, `...rejected` on `REJECTED`/`REJECTED_FUNDS`, `...needs_review` on `NEEDS_REVIEW`, plus the caller's
outbox messages (the store fills `redemption_id`, `player_id`, `sandbox`; a caller cannot override them). The
saga publishes no extra message after D-1; the hook stays because an invalid payload is how atomicity is pinned.
`apply` throws `IllegalTransitionError` (name checked by tests) for a pair outside the table and for
`NEEDS_REVIEW -> UNKNOWN` unless the latest history entry into `NEEDS_REVIEW` came from `UNKNOWN`; it returns
`applied: false` when `expectFrom` does not match or the `dedupe` row exists; `reservation` acts only while the
reservation is `reserved`. Implementations take a clock: `new PgRedemptionStore(db, { now })`. The Postgres
implementation wraps `runWithTenant` around the explicit `tenantId`.

4.2 `RedemptionSagaService` (`services/redemption-saga.service.ts`), constructed with `SagaDeps = { store, coins,
adapterFor(tenantId, sandbox), rewardRequest(order), clock, random }`. `rewardRequest` builds the `RewardRequest`
(including the player-id to external-player-id mapping) from the frozen order; the same request goes to
`issueReward` and to every `getRewardStatus`. Methods: `redeem`, `sweep(now)`, `onCasinoReport(tenantId, id,
report, eventId)`, `replay`, `resolveReview`. There is no crash hook: tests kill the process from outside, on the
ports. Errors the saga throws carry a `code` (`insufficient_funds`, `forbidden`, `illegal_transition`,
`release_not_allowed`, `redemption_not_found`). Consumer name for inbox rows: `engagement.redemption-saga`.

4.3 `services/backoff.ts`: `MAX_ATTEMPTS = 8`, `MAX_UNKNOWN_AGE_MS = 24 h`, `ISSUING_LEASE_MS = 60 s`,
`backoffDelayMs(attempt, random) = floor(random() * min(300 s, 1 s * 2^(attempt-1)))`. The 30 s grace of a
`REQUESTED` order is a store constant.

4.4 Services used by controllers: `RedemptionsService` (`redeem`, `getOwn`, `getForOperator`, `listForOperator`,
`resolveReview`) and `StoreItemsService` (`create`, `update`, `listActive`, `listAll`).

4.5 Names taken from the payments Stage A contract and flagged as ASSUMED until that service's fix round ends:
the four routes `POST /internal/v1/coins/reserve|capture|release|refund`, the refusal codes `insufficient_funds`,
`invalid_reserve_transition`, `reserve_not_found`, `operation_conflict`, and the coin events
`payments.coins.reserved|captured|released|refunded`. The saga consumes none of the events (the HTTP answer is the
result) and registers none. The compose seeding route in `store.compose.test.ts` (`POST /internal/v1/coins/credit`
with the service identity) is also assumed. The sandbox ledger of payments is not in its spec yet: the saga passes
the flag beside the request (never in the body) and the test fake keys wallets by (player, sandbox).

## 5. Data (engagement database, migration `Store1732300000000`, all tenant tables `ENABLE`+`FORCE` RLS)

- `store_items(id uuid pk, tenant_id, version int, name, description, image_url, price int check > 0, reward jsonb, stock int null check >= 0, per_player_limit int null, active bool)`.
- `item_player_usage(tenant_id, item_id, player_id, used int check >= 0, pk(tenant_id,item_id,player_id))`: the per-player counter.
- `redemptions(id uuid pk, tenant_id, player_id, sandbox bool, item_id, item_version, price, reward jsonb, operation_key, state, attempts, next_attempt_at, unknown_since, casino_reference, failure_reason, reservation, created_at, updated_at, unique(tenant_id, player_id, operation_key))`.
- `redemption_history(id, tenant_id, redemption_id, from_state, to_state, cause, at)`: append-only (no UPDATE/DELETE grant).
- `redemption_work_queue(redemption_id pk, tenant_id, next_attempt_at)`: no RLS, ids and times only, so the
  sweeper finds work across tenants without `BYPASSRLS`; maintained by `apply` and `placeOrder` in the same
  transaction.
- bus `outbox`/`inbox` as in `packages/bus`.

## 6. Contracts (`packages/contracts`, pinned by `store.contracts.test.ts`)

`store.ts`: catalog and redemption DTOs, `REDEMPTION_STATUSES`, `PUBLIC_STATUS_OF`, `STORE_ERROR_CODES` (with
`release_not_allowed`), `PrincipalHeaders`, engagement events `engagement.redemption.status_changed|issued|rejected|
needs_review`. **Removed** (D-1, D-2): the bus commands `engagement.hold.*`, the events `payments.hold.*`, and
the store's own adapter port. `casino-adapter.ts` and `ingest.ts` are taken unchanged from the ingest branch
(commit d822a75) in their own commit. `ErrorBody` gained an optional `code`.

## 7. API

Player: `GET /v1/store/items` (active only), `POST /v1/redemptions` (header `Idempotency-Key`, body `{ item_id }`,
strict) -> 202 + redemption (replay: header `Idempotent-Replayed: true`), **409 `insufficient_funds`** when payments
refuses the reserve, `GET /v1/redemptions/:id` (own only; shows `failure_reason`, except for `NEEDS_REVIEW`).
Operator: `POST /v1/store/items`, `PATCH /v1/store/items/:id` (owner, admin), `GET /v1/operator/redemptions?status=`
and `GET /v1/operator/redemptions/:id` (owner, admin, analyst), `POST /v1/operator/redemptions/:id/resolve` (owner,
admin).
Error codes (HTTP): `item_price_invalid` 422, `item_not_found` 404, `item_inactive` 409, `out_of_stock` 409,
`limit_reached` 409, `insufficient_funds` 409, `idempotency_key_reused` 422, `idempotency_in_progress` 409,
`redemption_not_found` 404, `forbidden` 403, `illegal_transition` 409, `release_not_allowed` 409. Body schema
failures are 400. A same-key call in flight is 409 retryable, a later replay returns the stored result, a changed
body is 422 (D-3).

## 8. Decisions

- **D1 (replay) is SUPERSEDED by D-8.** `NEEDS_REVIEW -> UNKNOWN` stays in the table, but `apply` allows it only for
  a review entered from `UNKNOWN`. Alternative still open: operator `resolve not_issued` only.
- **D2 (POST 202, insufficient funds visible only on GET) is SUPERSEDED by D-8.** The reserve is synchronous (D-1),
  so the POST answers 409 `insufficient_funds`. The player still reads `failure_reason = insufficient_funds` on
  GET and in the event. The public word of `REJECTED_FUNDS` stays `failed_refunded`.
- **D3** The sweeper acts on an `ISSUING` row only after its lease expires, and then treats it as `UNKNOWN`
  (never as "not issued").
- **D4** Role and sandbox arrive through placeholder headers until identity lands. Owner tracking: re-point
  `I-API-5` and the compose `I-OWN` tests at verified claims then.
- **D5** `pending` (casino B ticket) lands in `UNKNOWN` with the ref stored (no new state, so the oracle changes only
  by the `REQUESTED -> NEEDS_REVIEW` row). The ticket does not consume attempts; it ages out at 24 h.
- **D6** The automatic path never releases on `not_found` (stricter than D-2); the operator path may, after the
  issue deadline and a fresh lookup. Owner call if even that should go.
- **D7** `engagement.redemption.requested` (foundation event) is not emitted: `status_changed(null -> REQUESTED)`
  covers it.

## 9. Out of scope

The casino adapter and its classification table (the integrations module), the payments reserve implementation
and its sandbox ledger (the payments service), the websocket push of status changes (MIO-112), the operator console
UI, wheel fairness (MIO-069), the DLQ/replay CLI beyond `replay` on the service, chaos suite and
`pnpm demo --faults` (MIO-145), the migration and Nest wiring (Stage B). Metering of redemptions (none exists).

## 10. How the red tests run

- Unit (no stack): `cd apps/engagement && nice npx jest --maxWorkers=1`. `memory-store.conformance.test.ts` and the
  contract tests are green already; they keep the fake and the contracts honest. Everything else fails with
  `Cannot find module` for the module Stage B creates.
- Postgres store contract: `pnpm --filter @ex-mio/engagement test:pg` with `DATABASE_URL` set (needs only
  the compose postgres; take the compose lock, bring up `postgres` alone, `down -v` after). Same
  `storeConformance` suite as the fake. CI runs it in the `compose` job.
- Stack: `tests/compose/src/store.compose.test.ts`, fails with 404 on the new routes.
