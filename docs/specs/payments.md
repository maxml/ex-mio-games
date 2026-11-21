# Payments: coin ledger, balances, billing, usage

Epic spec for `apps/payments`. Backlog: MIO-080..086 (ledger), MIO-090, 091, 093, 095, 098 (billing,
metering), MIO-150 rows 02, 05, 06, 08, 13, 15..20, 28. Contracts live in `packages/contracts`
(`src/payments.ts`, `src/events.ts`). Status: spec + red tests (stage A); no implementation yet.

## 1. Behaviour

Payments is the only service that changes a coin balance. Everyone else reads a balance and sends commands.

- **Ledger.** Double-entry in Postgres (the payments database), integer amounts, currency `COIN`.
  One wallet per (tenant, player), made of two accounts (`player_available`, `player_held`), plus two
  tenant system accounts (`tenant_issuance`, `tenant_redeemed`). Every movement is one journal
  transaction with two or more legs; a materialised balance per account is updated in the same
  database transaction. The journal is append-only; corrections are new transactions.
- **Commands** (internal, service identity only): `credit` (a spin reward), `reserve` (a redemption holds
  coins), then `capture` (the coins are spent) or `release` (the coins come back), and `refund` (a
  captured reserve is returned). Each command has its own idempotency key and acts on an explicit reserve
  id chosen by the caller.
- **Read.** `GET /v1/me/balance` (player), `GET /v1/players/:player_id/balance` (operator). A Redis
  projection (`tenantCacheKey(tenant, 'balance', walletId)`) serves reads; it is never read by a
  command and falls back to the database when Redis is down.
- **Events** (outbox, same transaction): `payments.coins.credited`, `.reserved`, `.captured`,
  `.released`, and `.refunded` (added: a refund changes a balance, so projections must hear of it).
- **Reconciliation.** A per-tenant job recomputes every account balance from its legs, checks every
  transaction balances and each reserve's state against its transactions, writes a durable run record and a
  conservation report. It never repairs.
- **Billing (operator).** Plans (`free`, `pro`, `scale`, integer cents), a subscription per tenant, an
  invoice per charge, through a `PaymentProvider` port. Default adapter `fake` (card ending 4242
  accepted, ending 0002 declined). The `stripe` adapter is a stub selected by `STRIPE_SECRET_KEY`;
  every method throws `NotConfiguredError`.
- **Usage metering.** The bus handler counts `engagement.spin.completed` per tenant and calendar month:
  spins and distinct players (monthly active players). A report per period is sent to the provider once.
- **Erasure.** The player-to-wallet link (`wallet_owner_links`) can be deleted. The wallet id, accounts,
  balances and journal stay; nothing in the ledger carries a user id.

## 2. State tables

**Reserve** (`reserves.state`, changed only by a conditional `UPDATE ... WHERE state = <expected>`):

| From       | `capture`                    | `release`                    | `refund`                     |
| ---------- | ---------------------------- | ---------------------------- | ---------------------------- |
| (none)     | `reserve_not_found`          | `reserve_not_found`          | `reserve_not_found`          |
| `reserved` | `captured`                   | `released`                   | `invalid_reserve_transition` |
| `captured` | `invalid_reserve_transition` | `invalid_reserve_transition` | `refunded`                   |
| `released` | `invalid_reserve_transition` | `invalid_reserve_transition` | `invalid_reserve_transition` |
| `refunded` | `invalid_reserve_transition` | `invalid_reserve_transition` | `invalid_reserve_transition` |

A retry of the same command (same key, or same reserve id after the HTTP record expired) returns the stored
result instead of consulting this table.

**Legs per command** (debit side first; amount = the command's or the reserve's amount):

| Command | operation_type | debit              | credit             |
| ------- | -------------- | ------------------ | ------------------ |
| credit  | `spin_award`   | `tenant_issuance`  | `player_available` |
| reserve | `reserve`      | `player_available` | `player_held`      |
| capture | `capture`      | `player_held`      | `tenant_redeemed`  |
| release | `release`      | `player_held`      | `player_available` |
| refund  | `refund`       | `tenant_redeemed`  | `player_available` |

Balances are `credits - debits` for player accounts and `tenant_redeemed`, `debits - credits` for
`tenant_issuance`; all are `>= 0`. Conservation: `issued = available + held + captured - refunded`.

**Subscription:** `active` (card accepted) or `declined` (card refused: the subscription row exists for the
audit trail, the tenant has no active subscription); `canceled`. **Invoice:** `paid` or `failed`.
**Reconciliation run:** `ok`, `mismatch` (at least one mismatch), `failed` (the run did not complete).

## 3. API and event contracts

Schemas: `packages/contracts/src/payments.ts`. All coin routes parse input with them (`parseInput`).

| Route                                | Who                  | Body                              | Success                   |
| ------------------------------------ | -------------------- | --------------------------------- | ------------------------- |
| `POST /internal/v1/coins/credit`     | service `engagement` | `CreditCoinsRequest`              | 201 `CoinOperationResult` |
| `POST /internal/v1/coins/reserve`    | service `engagement` | `ReserveCoinsRequest`             | 201                       |
| `POST /internal/v1/coins/capture`    | service `engagement` | `ReserveRefRequest`               | 200/201                   |
| `POST /internal/v1/coins/release`    | service `engagement` | `ReserveRefRequest`               | 200/201                   |
| `POST /internal/v1/coins/refund`     | service `engagement` | `ReserveRefRequest`               | 200/201                   |
| `GET /v1/me/balance`                 | player               | none; the player is the principal | 200 `WalletBalance`       |
| `GET /v1/players/:player_id/balance` | operator             | none                              | 200 `WalletBalance`       |

- Service identity (placeholder until the identity token lands): headers `x-service-id` and
  `x-service-token`, checked by `ServiceTokenGuard` against `SERVICE_TOKENS` (`{ engagement: <secret> }`
  from config). Only `engagement` may call the five commands. Player/operator principals
  (`x-principal-kind`) get 403 there. There is no public route that credits; `/v1/credits` of the
  foundation is removed.
- Every command needs `Idempotency-Key` (8..128 chars); a replay answers the stored status and sets
  `idempotent-replayed: true`.
- **Error codes** (`PaymentsErrorBody { code, message }`):
  `validation_failed` 400, `idempotency_key_required` 400, `forbidden` 403, `reserve_not_found` 404,
  `wallet_not_found` 404, `insufficient_funds` 409, `invalid_reserve_transition` 409, `operation_conflict` 409,
  `idempotency_in_progress` 409, `idempotency_key_reused` 422. An unexpected error is 500 and never a
  stored success.
- **Events:** `payments.coins.credited` v1 (existing; `credit_id` = journal transaction id) and v1 of
  `.reserved`, `.captured`, `.released`, `.refunded` with `{ transaction_id, player_id, wallet_id, reserve_id,
amount, available_after, held_after }`.
- **Consumed:** `engagement.spin.completed` v1 (usage metering), through the inbox.

## 4. Data model and database invariants

Tables (all with `tenant_id`, `ENABLE`+`FORCE` RLS via `enableTenantRls`, except `billing_plans`):
`wallets(tenant_id, id)`, `wallet_owner_links(tenant_id, wallet_id, user_id)`,
`accounts(tenant_id, id, kind, wallet_id, currency)`, `balances(tenant_id, account_id, amount BIGINT)`,
`journal_transactions(tenant_id, id, operation_type, operation_id, currency, created_at, created_by)`,
`ledger_entries(tenant_id, id, transaction_id, account_id, direction, amount BIGINT, currency)`,
`reserves(tenant_id, id, wallet_id, amount BIGINT, state, ...)`, `reconciliation_runs`, `usage_events`,
`usage_meters`, `usage_reports`, `billing_plans`, `subscriptions`, `invoices`, plus the existing
`idempotency_keys`, `outbox`, `inbox`. The foundation's `coin_credits` is dropped by the migration.

Roles: the migration role `payments` owns the tables. The runtime role `payments_app` (created in
`docker/postgres/init.sh`, NOSUPERUSER, NOBYPASSRLS, not an owner) gets `SELECT, INSERT` on the journal
and entries (no `UPDATE`, `DELETE`), `SELECT, INSERT, UPDATE` on `balances` and `reserves`, `DELETE` on
`wallet_owner_links`. The app connects as `payments_app`; `migrate` as `payments`.

Constraints: `UNIQUE (tenant_id, operation_type, operation_id)` on `journal_transactions`; `CHECK (amount

> 0 AND amount <= 1000000000000)`on entries and reserves;`CHECK (amount >= 0)`on balances; a deferred
constraint trigger`journal_balanced` (every transaction has >= 2 legs, debits = credits, leg currency =
> transaction currency = account currency).

## 5. Ledger commands (`LedgerService`, one tenant transaction each)

Each command runs inside `Db.idempotent` and, in that one transaction: inserts the journal transaction and
legs, applies the balance changes with conditional updates (`UPDATE balances SET amount = amount - $n
WHERE ... AND amount >= $n`; credits add; no absolute write), changes the reserve state, enqueues the
event, stores the idempotency record. The durable id of a business operation (`spin_id`, `reserve_id`)
is the `operation_id`; the HTTP record is only a response cache. A fault hook (`LEDGER_FAULTS.hit(point)`,
no-op in production) is called after the journal insert (`after_journal`), after the balance update
(`after_balance`) and after the outbox insert (`after_outbox`), and by the reconciliation scan
(`reconciliation_scan`). `LedgerError(code)` carries the domain error code. `eraseIdentityLink(playerId)`
deletes the link row.

## 6. Balance read (`BalanceService`)

`readByPlayer(playerId)` and `readByWallet(walletId)` return `WalletBalance`; the wallet is looked up inside
the tenant transaction (`wallet_not_found` otherwise). The cache (`BALANCE_CACHE`, a `RedisCache`) is used
only here; a cache error is swallowed and the database answers. `onCoinEvent(event)` deletes the wallet's
key. Commands never receive or use the cache.

## 7. Reconciliation (`ReconciliationService`)

`run()` for the ambient tenant: recompute `credits - debits` per account and compare with `balances`
(`balance_drift`), re-check each transaction balances (`unbalanced_transaction`), compare each reserve's state
with its transactions (`reserve_state_drift`). It writes a `reconciliation_runs` row and returns a
`ReconciliationRun` with the `ConservationReport` (`issued`, `available`, `held`, `captured`, `released`,
`refunded`, `holds`). An exception inside the scan yields a run with status `failed`, not a throw and not
`ok`. `last()` returns the latest run plus `stale: true` when it finished more than 2 hours ago. It never
writes to `balances`.

## 8. Usage metering (`UsageService`)

`handle(manager, event)` is the inbox handler: it inserts `(tenant_id, event_id)` into `usage_events` (conflict =
already counted), then increments the `spins` meter and records `(period, player_id)` for MAU, where
period = UTC `YYYY-MM` of `occurred_at`. `report(period)` returns `UsageReport`. `reportToProvider(period)`
sends it once, keyed `usage:<tenant>:<period>`, and records it in `usage_reports`.

## 9. Billing and the provider port

`PaymentProvider` (`services/providers/payment-provider.ts`): `kind`, `createCustomer`, `subscribe`
(`active` with a subscription id, or `declined`), `getSubscription`, `cancelSubscription`, `reportUsage`
(idempotent per key). `FakePaymentProvider`, `StripePaymentProvider` (throws `NotConfiguredError`),
`selectPaymentProvider(env)` (fake unless `STRIPE_SECRET_KEY` is non-empty; read once at start-up). No Stripe
name or import appears outside `stripe.provider.ts`. `BillingService`: `listPlans`, `subscribe(request,
key)` (idempotent, `validation_failed` for an unknown plan), `currentSubscription`, `listInvoices`.

## 10. Invariants, choke points and tests

All pgtests need Postgres (section 12); `*.test.ts` run without it.

| Invariant                                                                  | Backlog criterion                                | Choke point                                      | Test                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------- |
| INV-L1 balanced legs enforced by the DB                                    | MIO-081 one leg / unequal / currency; MIO-150-18 | trigger `journal_balanced`                       | `model/ledger.schema.pgtest.ts`               |
| INV-L2 journal append-only; app role not owner                             | MIO-081 permission error                         | grants, role                                     | same                                          |
| INV-L3 one transaction per business operation                              | MIO-081 duplicate award; MIO-150-16              | unique constraint                                | same                                          |
| INV-L4 no negative balance                                                 | MIO-081                                          | CHECK on `balances`                              | same                                          |
| INV-L5 integer amounts, cap, no float columns                              | MIO-081 boundaries, MIO-150-08                   | CHECKs, column types                             | same; `contracts/payments.contracts.test.ts`  |
| INV-L6 RLS on every ledger table                                           | MIO-032                                          | `enableTenantRls`                                | same                                          |
| INV-O1/O2 erasure keeps the account                                        | epic spec                                        | no user id in ledger tables; `eraseIdentityLink` | same; `services/ledger.service.pgtest.ts`     |
| INV-C1 concurrent reserves never overspend                                 | MIO-082 50 parallel, MIO-150-17                  | conditional UPDATE                               | `services/ledger.service.pgtest.ts`           |
| INV-C2 mixed concurrency conserves                                         | MIO-082, MIO-150-05                              | conditional UPDATE                               | same                                          |
| INV-I1 same key replays once                                               | MIO-082                                          | `Db.idempotent`                                  | same                                          |
| INV-I2 changed body 422                                                    | MIO-082, MIO-086                                 | request hash                                     | same                                          |
| INV-I3 replay after record expiry                                          | MIO-086, MIO-150-16                              | unique `operation_id`, parameter compare         | same                                          |
| INV-T1 transitions; capture after release rejected                         | MIO-082                                          | conditional state UPDATE                         | same                                          |
| INV-T2 double capture idempotent                                           | MIO-082                                          | per-phase operation key                          | same                                          |
| INV-T3 explicit reserve id                                                 | epic spec                                        | command body, unique `operation_id`              | same                                          |
| INV-A1 rollback together                                                   | MIO-082 three tests, MIO-150-06/19               | one transaction, fault hook                      | same                                          |
| INV-E1 event per phase, same tx                                            | MIO-082                                          | `Db.publish` in effect                           | same                                          |
| INV-B1..B3 fresh read, Redis down, tenant-scoped cache, no cache on writes | MIO-083                                          | `BalanceService`, `tenantCacheKey`               | `services/balance.service.pgtest.ts`          |
| INV-B4 own balance only                                                    | MIO-083                                          | controller principal                             | `controllers/coins.controller.test.ts`        |
| INV-X1 only `engagement` moves coins; no public credit                     | MIO-082, MIO-150-02                              | `ServiceTokenGuard`, route table                 | same                                          |
| INV-X2 validation before service                                           | MIO-081, MIO-150-08/13                           | zod `parseInput`                                 | same                                          |
| INV-X3 defined error codes                                                 | MIO-150-19                                       | controller exception mapping                     | same                                          |
| INV-R1..R3 reconciliation                                                  | MIO-084, MIO-150-28                              | `ReconciliationService`                          | `services/reconciliation.service.pgtest.ts`   |
| INV-M1..M4 metering                                                        | MIO-095                                          | inbox handler, `usage_events` PK                 | `services/usage.service.pgtest.ts`            |
| INV-P1..P4 plans, cards, idempotent subscribe, tenant isolation            | MIO-091, 093, 098                                | `BillingService`                                 | `services/billing.service.pgtest.ts`          |
| INV-PP1..PP3 provider port                                                 | MIO-090                                          | adapters, `selectPaymentProvider`                | `services/providers/payment-provider.test.ts` |

## 11. Out of scope

Webhooks, hosted checkout page, entitlements (MIO-094, 096); platform revenue view (MIO-099); player ledger
history (MIO-085) and the operator adjustment path with audit (MIO-161); the `HELD`-versus-redemption
cross-check with engagement in reconciliation (needs the engagement service); the sandbox flag on events;
the real identity token (placeholder headers stay); a real Stripe implementation; the Redis projection
being fed by the bus in production (`onCoinEvent` is the handler, wiring a queue binding is stage B).

## 12. Running the tests and stage B notes

```sh
docker compose up -d --wait postgres          # init.sh creates the roles, including payments_app
DATABASE_URL=postgresql://payments:payments-dev@localhost:54329/payments pnpm --filter @ex-mio/payments migrate
pnpm --filter @ex-mio/payments test           # unit: controllers, provider
pnpm --filter @ex-mio/payments test:db        # pgtests (need the database above)
```

Stage B must: add the `payments_app` role to `init.sh` and the compose `payments` service
(`DATABASE_URL` as `payments_app`, migrate as `payments`), write migration `Ledger` (and drop
`coin_credits`), delete the foundation's `credits.*` files and `credits.test.ts`, and add the modules the
tests import: `ledger.module.ts`, `services/{ledger,balance,reconciliation,usage,billing}.service.ts`,
`services/ledger.errors.ts`, `services/providers/*`, `controllers/{coins,balance}.controller.ts`,
`controllers/service-token.guard.ts`, `model/ledger.faults.ts`.
