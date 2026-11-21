# Spec: engagement store (bonus catalog and redemption saga)

Epic L4. Backlog: MIO-065, MIO-066, MIO-067, MIO-068, MIO-142 to MIO-145 (store and saga parts). Stage A:
this spec and the red tests. The words "must" and "never" are checked by a test named in §3.

## 1. Behaviour

A tenant's operator keeps a catalog of items (price in whole coins, a reward mapping in canonical form, optional
stock, optional per-player limit, active flag). A player redeems an item with `POST /v1/redemptions`.

The redemption is a saga over two databases (engagement owns stock and limit, payments owns coins) and one
external system (the casino, reached through the integrations adapter):

1. **Order** (engagement, one transaction): conditional decrement of stock and per-player limit, freeze price and
   reward mapping, insert `REQUESTED`, outbox `engagement.hold.place` (`operation_id = hold:{id}`).
2. **Hold** (payments): `payments.hold.placed` -> `RESERVED`; `payments.hold.rejected` -> `REJECTED_FUNDS` and the
   stock reservation is released. No casino call happens before a hold exists.
3. **Issue** (the sweeper, never inline): `RESERVED -> ISSUING` is committed (attempt recorded, 60 s lease)
   BEFORE the adapter is called, with key `redeem:{id}`. Result `issued` -> `ISSUED` + `engagement.hold.capture`;
   `rejected` (adapter's final list) -> `REJECTED` + `engagement.hold.release`; `unknown` or a thrown error ->
   `UNKNOWN`, next attempt at `now + backoff`.
4. **Recovery** (the sweeper): for `UNKNOWN`, and for an `ISSUING` whose lease expired (a crash), ask
   `getRewardStatus(redeem:{id})` first. `issued` -> `ISSUED`; `rejected` -> `REJECTED`; `not_found` -> retry with
   the same key (`ISSUING`, attempts + 1) while attempts < 8; `unknown` -> reschedule. Past 8 attempts, or 24 h in
   `UNKNOWN`, -> `NEEDS_REVIEW`. Coins are never released or captured on an unknown outcome.
5. **Settle**: `payments.hold.captured` -> `COMPLETED` (reservation committed); `payments.hold.released` ->
   `RELEASED` (reservation released: stock and limit are back).
6. **Compensation after capture**: a casino report `revoked` on a `COMPLETED` redemption -> `REFUNDED` +
   `engagement.hold.refund`. At most once.
7. **Late and conflicting news** (`onCasinoReport`, `payments.hold.command_rejected`) never moves coins: it moves
   the redemption to `NEEDS_REVIEW` with a reason and raises `engagement.redemption.needs_review`.
8. **Operator**: `resolveReview` (owner/admin, with a reason, audited in the history cause) -> `ISSUED` or
   `REJECTED`, then the normal capture or release follows. `replay` re-enters the unknown path with a fresh
   attempt budget.

Sandbox: the `sandbox` flag of a redemption comes from the server-side request context (placeholder header
`x-sandbox` until identity issues key-derived claims), never from a body. A sandbox redemption is issued only through
the sandbox adapter, and every command and event of it carries `sandbox: true` so metering excludes it and nothing
else about it differs from production. Lookup of a redemption includes the flag.

## 2. State tables

**Redemption** (the oracle is typed out in `apps/engagement/src/redemptions/testing/transition-oracle.ts`; the
exported `REDEMPTION_TRANSITIONS` must equal it row for row). 20 rows: the 19 rows of MIO-066 plus D1.

| From               | To                | Trigger                                   | Effect in the same transaction                              |
| ------------------ | ----------------- | ----------------------------------------- | ----------------------------------------------------------- |
| REQUESTED          | RESERVED          | `hold.placed`, amount = frozen price      | `next_attempt_at = now`                                     |
| REQUESTED          | REJECTED_FUNDS    | `hold.rejected`                           | release reservation, reason `insufficient_funds`            |
| RESERVED           | ISSUING           | sweeper                                   | attempts + 1, lease 60 s                                    |
| ISSUING            | ISSUED            | adapter `issued`                          | reference stored, outbox `hold.capture`                     |
| ISSUING            | REJECTED          | adapter `rejected`                        | reason `casino_rejected:<code>`, outbox `hold.release`      |
| ISSUING            | UNKNOWN           | adapter `unknown`/throw, or lease expired | `next_attempt_at = now + backoff`; `unknown_since` set once |
| UNKNOWN            | ISSUED / REJECTED | inquiry `issued` / `rejected`             | as above                                                    |
| UNKNOWN            | ISSUING           | inquiry `not_found`, attempts < 8         | attempts + 1, same key                                      |
| UNKNOWN            | NEEDS_REVIEW      | attempts = 8 or age >= 24 h               | reason `attempts_exhausted` / `unknown_too_long`            |
| ISSUED             | COMPLETED         | `hold.captured`                           | commit reservation                                          |
| REJECTED           | RELEASED          | `hold.released`                           | release reservation                                         |
| COMPLETED          | REFUNDED          | report `revoked`                          | outbox `hold.refund`                                        |
| REJECTED, RELEASED | NEEDS_REVIEW      | late success                              | reason `late_success_after_release`                         |
| ISSUED, COMPLETED  | NEEDS_REVIEW      | late rejection / capture rejected         | `late_rejection_after_complete` / `hold_already_released`   |
| REJECTED           | NEEDS_REVIEW      | release rejected                          | `hold_already_captured`                                     |
| NEEDS_REVIEW       | ISSUED / REJECTED | operator resolve                          | as above                                                    |
| NEEDS_REVIEW       | UNKNOWN           | `replay` (D1)                             | attempts reset, `unknown_since` set                         |

Every other pair is refused by `assertTransition`. A duplicate trigger (same event id, or a state that is already
past it) applies nothing.

**Hold (payments)** is as in MIO-066: `HELD -> CAPTURED | RELEASED`, `CAPTURED -> REFUNDED`, repeated commands
return the same result, capture after release answers `hold_already_released`, release after capture answers
`hold_already_captured`, refund of an uncaptured hold answers `hold_not_captured`. The tests carry a fake of this
table (`testing/world.ts`); payments' own epic owns the real one.

## 3. Invariants, choke points, tests

| Id               | Invariant (backlog criterion)                                                                                                                                                                                 | Choke point                                                                                     | Tests                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| I-STATE-1        | Only table transitions exist; code table = spec table (MIO-067)                                                                                                                                               | `model/redemption-state.ts` `assertTransition`, called by `RedemptionStore.apply`               | `model/redemption-state.test.ts` (table equality, all 121 pairs); store contract 'apply rejects a pair outside the table' |
| I-ORDER-1        | One order per (tenant, player, operation key); a different item under the same key is `idempotency_key_reused` (MIO-142)                                                                                      | `RedemptionStore.placeOrder`                                                                    | store contract (3 tests); saga `I-ORDER-1`; compose `I-ORDER-1`, `I-ORDER-1b`                                             |
| I-ORDER-2        | Stock and limit are counters changed only by conditional update; never below zero under 50 parallel reservations (MIO-065, MIO-066)                                                                           | `placeOrder` (one conditional `UPDATE ... WHERE stock > 0`)                                     | store contract (50 parallel, last item, limit); saga `I-ORDER-2/3`; compose `I-ORDER-2`                                   |
| I-ORDER-4        | Price and reward mapping frozen on the order (MIO-066)                                                                                                                                                        | `placeOrder` copies them; saga reads only the record                                            | store contract 'frozen'; saga `I-ORDER-4`                                                                                 |
| I-ORDER-5        | A hold whose amount differs from the frozen price is not applied                                                                                                                                              | saga `handle(hold.placed)`                                                                      | saga `I-ORDER-5`                                                                                                          |
| I-OUTCOME-1..4   | Success: one capture and one reward; funds failure: stock back, no casino call; rejection: `REJECTED` then `RELEASED`, balance restored, no refund; RELEASED only after payments confirmed (MIO-066, MIO-144) | saga + `apply`                                                                                  | saga `I-OUTCOME-1..4`                                                                                                     |
| I-AMBIGUOUS-1..7 | Timeout is `UNKNOWN`, coins held; recovery by OUR key, same key on retry, 8 attempts, 24 h, unknown code retryable, restart resumes (MIO-068, MIO-143)                                                        | saga `runIssue`/`inquire`; `services/backoff.ts`                                                | saga `I-AMBIGUOUS-1..7`; `services/backoff.test.ts`                                                                       |
| I-DEDUPE-1,2     | Duplicate events/callbacks: one transition, one capture                                                                                                                                                       | `apply` with `dedupe` + `expectFrom`                                                            | saga `I-DEDUPE-1,2`; store contract 'repeated event id'                                                                   |
| I-LATE-1..4      | Late/conflicting news goes to `NEEDS_REVIEW`, no coin movement, reader sees the reason (MIO-066, MIO-067)                                                                                                     | saga `onCasinoReport`, `handle(command_rejected)`                                               | saga `I-LATE-1..4`                                                                                                        |
| I-REFUND-1       | At most one refund per redemption (MIO-144)                                                                                                                                                                   | `apply` guard `expectFrom: COMPLETED`                                                           | saga `I-REFUND-1`                                                                                                         |
| I-REVIEW-1,2     | Only owner/admin resolve; the reason is audited                                                                                                                                                               | saga `resolveReview` + controller                                                               | saga `I-REVIEW-*`; controller `I-OPS-2`                                                                                   |
| I-CRASH-1..8     | Killed at each durable boundary the run ends as the no-crash run, one reward at most, ledger conserved (MIO-066)                                                                                              | single-transaction `apply` (state + outbox + inbox + reservation); sweeper; `CrashPoints` hooks | saga `I-CRASH-1..8`                                                                                                       |
| I-OWN-1,2        | Player B cannot read A's redemption; lookup is `(tenant, player, sandbox, id)`; 404 not 403 (MIO-067, MIO-154)                                                                                                | `RedemptionStore.getOwn` + RLS; controller passes the caller's scope                            | store contract 'lookup'; controller `I-OWN-1`; compose `I-OWN-1/2`, `I-ISO-2`                                             |
| I-ISO-1          | A tenant never sees another tenant's items (MIO-065)                                                                                                                                                          | RLS on `store_items`                                                                            | compose `I-ISO-1`                                                                                                         |
| I-API-1..7       | Roles (owner/admin edit items, analyst 403), price 422, validation before the service, error codes                                                                                                            | controllers (zod + role guard + exception filter)                                               | `controllers/store.controllers.test.ts`                                                                                   |
| I-VIEW-1,2       | Players see `pending` for `NEEDS_REVIEW` and never its reason; four public words                                                                                                                              | controller DTO mapper                                                                           | controller `I-VIEW-*`                                                                                                     |
| I-SANDBOX-1,2    | Sandbox redemptions use only the sandbox adapter, carry `sandbox` on every message, flag never from a body (MIO-092)                                                                                          | saga adapter choice from the order's flag; `apply` stamps events                                | saga `I-SANDBOX-*`; controller `I-API-5`                                                                                  |

## 4. Interfaces

`apps/engagement/src/redemptions/ports.ts` holds the stub types (frozen with the tests): `RedemptionStore` (every
method one atomic tenant-scoped transaction), `StateChange`, `CrashPoints`, `Clock`, `RedemptionRecord`,
`StoreRejection`.

4.1 `RedemptionStore.apply` writes, in the same transaction as the state change: history row, counters, the
`engagement.redemption.status_changed` event on every change, plus `...issued` on entering `ISSUED`,
`...rejected` on `REJECTED`/`REJECTED_FUNDS`, `...needs_review` on `NEEDS_REVIEW`, plus the caller's outbox
messages (the store fills `redemption_id`, `player_id`, `sandbox`). It throws `IllegalTransitionError` (name
checked by tests) for a pair outside the table, returns `applied: false` when `expectFrom` does not match or the
`dedupe` row exists. The Postgres implementation wraps `runWithTenant` around the explicit `tenantId`.

4.2 `RedemptionSagaService` (`services/redemption-saga.service.ts`), constructed with
`{ store, adapters: { production, sandbox }, clock, random, crash }`:
`redeem(scope, operationKey, itemId)`, `handle(event)` (the six `payments.hold.*` events), `onCasinoReport(tenantId,
id, { outcome: 'issued'|'rejected'|'revoked', ... })`, `sweep(now): Promise<number>`, `replay(tenantId, id)`,
`resolveReview(tenantId, id, { outcome, reason, operator })`. `crash.hit('after_issuing_committed')` is called right
after the `ISSUING` commit and `crash.hit('after_casino_effect')` right after the adapter returns, before its
result is recorded. Consumer name for inbox rows: `engagement.redemption-saga`.

4.3 `services/backoff.ts`: `MAX_ATTEMPTS = 8`, `MAX_UNKNOWN_AGE_MS = 24 h`, `ISSUING_LEASE_MS = 60 s`,
`backoffDelayMs(attempt, random) = floor(random() * min(300 s, 1 s * 2^(attempt-1)))`.

4.4 Services used by controllers: `RedemptionsService` (`redeem`, `getOwn`, `listForOperator`, `resolveReview`) and
`StoreItemsService` (`create`, `update`, `listActive`, `listAll`).

## 5. Data (engagement database, migration `Store1732300000000`, all tenant tables `ENABLE`+`FORCE` RLS)

- `store_items(id uuid pk, tenant_id, version int, name, description, image_url, price int check > 0, reward jsonb, stock int null check >= 0, per_player_limit int null, active bool)`.
- `item_player_usage(tenant_id, item_id, player_id, used int check >= 0, pk(tenant_id,item_id,player_id))`: the per-player counter.
- `redemptions(id uuid pk, tenant_id, player_id, sandbox bool, item_id, item_version, price, reward jsonb, operation_key, state, attempts, next_attempt_at, unknown_since, casino_reference, failure_reason, reservation, created_at, updated_at, unique(tenant_id, player_id, operation_key))`.
- `redemption_history(id, tenant_id, redemption_id, from_state, to_state, cause, at)`: append-only (no UPDATE/DELETE grant).
- `redemption_work_queue(redemption_id pk, tenant_id, next_attempt_at)`: no RLS, ids and times only, so the
  sweeper finds work across tenants without `BYPASSRLS`; maintained by `apply` in the same transaction.
- bus `outbox`/`inbox` as in `packages/bus`.

## 6. Contracts added (`packages/contracts/src/store.ts`, pinned by `store.contracts.test.ts`)

Catalog and redemption DTOs, `REDEMPTION_STATUSES`, `PUBLIC_STATUS_OF`, `STORE_ERROR_CODES`, `PrincipalHeaders`;
commands `engagement.hold.place|capture|release|refund`; payments events `payments.hold.placed|rejected|captured|
released|refunded|command_rejected`; engagement events `engagement.redemption.status_changed|issued|rejected|
needs_review`; the `RewardAdapter` port (`issueReward`, `getRewardStatus`) for the integrations module (epic
ingest). Payments (epic payments) implements the hold commands and events exactly as typed there.
`ErrorBody` gained an optional `code`.

## 7. API

Player: `GET /v1/store/items` (active only), `POST /v1/redemptions` (header `Idempotency-Key`, body `{ item_id }`,
strict) -> 202 + redemption (replay: header `Idempotent-Replayed: true`), `GET /v1/redemptions/:id` (own only).
Operator: `POST /v1/store/items`, `PATCH /v1/store/items/:id` (owner, admin), `GET /v1/operator/redemptions?status=`
(owner, admin, analyst), `POST /v1/operator/redemptions/:id/resolve` (owner, admin).
Error codes (HTTP): `item_price_invalid` 422, `item_not_found` 404, `item_inactive` 409, `out_of_stock` 409,
`limit_reached` 409, `idempotency_key_reused` 422, `idempotency_in_progress` 409, `redemption_not_found` 404,
`forbidden` 403, `illegal_transition` 409. Body schema failures are 400.

## 8. Decisions for the reviewer

- **D1** `NEEDS_REVIEW -> UNKNOWN` is a row MIO-066 does not have. MIO-068 requires `replay` to end `COMPLETED`;
  the table offers no way back into the retry path otherwise. Alternative: operator `resolve not_issued` only.
- **D2** MIO-066 says insufficient balance returns 409 `insufficient_funds` from the API. The hold is asynchronous,
  so `POST` returns 202 and the outcome is `failed_refunded` with `failure_reason = insufficient_funds` on `GET`
  (and in the event). A synchronous answer would need a payments balance read on the request path.
- **D3** The sweeper acts on an `ISSUING` row only after its lease expires, and then treats it as `UNKNOWN`
  (never as "not issued").
- **D4** Role and sandbox arrive through placeholder headers until the identity epic lands.

## 9. Out of scope

The casino adapter and its classification table (epic ingest), the payments hold implementation (epic payments),
the websocket push of status changes (MIO-112), the operator console UI, wheel fairness (MIO-069), the DLQ/replay
CLI beyond `replay` on the service, chaos suite and `pnpm demo --faults` (MIO-145), the migration and Nest wiring
(Stage B).

## 10. How the red tests run

- Unit (no stack): `cd apps/engagement && npx jest --maxWorkers=2` (`memory-store.conformance.test.ts` and the contract
  tests are green already; they keep the fake and the contracts honest). Everything else fails with
  `Cannot find module` for the module Stage B creates.
- Postgres contract: `redemption-store.pg.itest.ts`, command in its header.
- Stack: `tests/compose/src/store.compose.test.ts`, fails with 404 on the new routes.
