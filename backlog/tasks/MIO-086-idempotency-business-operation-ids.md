---
id: MIO-086
title: "Idempotency contract for value operations: scoped keys, durable business-operation ids"
epic: EPIC-08
priority: P0
money_impact: direct
risk_class: locks
status: todo
depends_on: []
blocked_by: ["starter: idempotency package"]
size: M
---

## Goal

A retried, replayed or forged request can never produce a second coin effect, a second spin or a second
redemption, and can never return one user's stored response to another user. This holds after the HTTP
idempotency record has expired.

## Scope

This task writes the product contract and its tests. The reusable mechanism (middleware, store, purge
job) comes from the starter's idempotency package; spins (MIO-063), redemptions (MIO-066) and coin
operations (MIO-082) adopt it.

1. **Key scope.** An HTTP idempotency record is keyed by
   `(tenant_id, principal, operation, client_key)`:
   - `principal` is the authenticated subject from the token (`user_id` for players and staff, the
     service id for service tokens), never a value from the request body;
   - `operation` is the HTTP method plus the route template (`POST /v1/redemptions`), or the command name
     for internal commands (`payments.reserve`).
   Two users of one tenant, or two routes, that send the same client key never share a record.
2. **Request fingerprint.** The record stores `request_hash = SHA-256` of the canonical request: the
   operation, the path parameters and the body canonicalised with RFC 8785 (JSON Canonicalization Scheme).
   Equivalent bodies (key order, whitespace) give the same hash.
3. **Status codes, one rule for the whole product.**
   - Same scope and same hash, first call finished: the stored status and body are returned.
   - Same scope and same hash, first call still running: `409 idempotency_in_progress` with `Retry-After`.
   - Same scope and a different hash: `422 idempotency_key_reused`, nothing executed.
   - Missing key on an operation that requires one: `400 idempotency_key_required`.
4. **Authorization before replay.** Authentication, tenant resolution and object authorization run on
   every call, including a replay. A stored response is returned only if the current principal would be
   allowed to make the original call now. A principal who has lost access gets the normal 403 or 404,
   never the stored body.
5. **Atomic effect and record.** The idempotency record (state `in_progress`, inserted first, row-locked),
   the business effect, the outbox message and the final record update (`completed`, status, body) commit
   in one database transaction. There is no window where the effect is committed and the record is not.
6. **Crash recovery.**
   - Crash before commit: nothing was committed; the retry executes once.
   - Crash after commit, before the response reached the client: the retry gets the stored response.
   - A record stuck `in_progress` (its transaction is gone) is detected by the row lock being free and is
     re-executed under the lock; it is never treated as completed.
7. **Durable business-operation id, independent of HTTP TTL.** Every value operation has an id derived
   deterministically from the scope: `operation_id = UUIDv5(namespace, tenant_id | principal | operation |
   client_key)`. Domain tables store it under a unique constraint that never expires
   (`spins.operation_id`, `redemptions.operation_id`, `journal_transactions (tenant_id, operation_type,
   operation_id)`). The HTTP record (TTL 24 hours) is only a response cache: after it is purged, a delayed
   replay hits the domain unique constraint and returns the existing operation (or 422 if the hash differs),
   and never creates a second one.
8. **Internal commands.** Commands between services (engagement to payments) carry the business-operation
   id as their idempotency key (`spin_award:{spin_id}`, `hold:{redemption_id}`, `capture:{redemption_id}`,
   `release:{redemption_id}`, `refund:{redemption_id}`); the key is scoped by the calling service identity.

## Acceptance criteria

Each test is written before the implementation and runs against the real database.

- **Same tenant, different user:** players A and B in one tenant send the same client key to
  `POST /v1/redemptions` with different bodies; two independent redemptions are created and B's response
  never contains A's redemption.
- **Same tenant, different user, same body:** two operations, not one replay.
- **Different route:** one client key used on `POST /v1/spins` and `POST /v1/redemptions` by the same
  player creates two independent operations.
- **Changed body:** same scope, different body returns 422 `idempotency_key_reused` and executes nothing.
- **Equivalent body:** same body with reordered keys and different whitespace returns the stored response.
- **In flight:** two parallel calls with the same scope and body: one executes, the other gets 409 with
  `Retry-After` or, after waiting, the stored response; exactly one effect.
- **Crash after effect:** the process is killed after the transaction commits and before the response
  is written; the retry returns the same response and the ledger shows one effect.
- **Crash before commit:** the process is killed inside the transaction; the retry executes once.
- **Replay after TTL:** the HTTP record is purged; a replay with the same key and body returns the
  original operation and creates no second spin, redemption or journal transaction.
- **Authorization before replay:** player A's session is revoked (or A's tenant is suspended); A's replay
  returns 401 or 402, not the stored body.
- **Mutations the reviewer re-applies:** drop `principal` from the key scope (the same-tenant test goes
  red); drop `operation` (the different-route test goes red); return the stored body before
  authorization (the revoked-session test goes red); move the record write into a second transaction
  (the crash-after-effect test goes red); remove the domain unique constraint on `operation_id` (the
  replay-after-TTL test goes red).

## Notes

The status codes follow the IETF HTTP API `Idempotency-Key` header draft (409 while in flight, 422 for a
reused key with a different payload). Every task in this backlog uses these codes; a domain conflict such
as insufficient funds or an already used spin credit is a separate 409 with its own error code.
