# Payments: coin ledger, balances, billing, usage

Area spec for `apps/payments`. Backlog: MIO-080..086 (ledger), MIO-090, 091, 093, 095, 098 (billing,
metering), MIO-150 rows 01, 02, 04..10, 12..20, 28. Contracts live in `packages/contracts`
(`src/payments.ts`, `src/events.ts`). Status: spec + red tests (stage A, fix round); no implementation yet.
Coordinator decisions that bind this area: D-1 (spin coins by event), D-5 (acting tenant), D-9
(idempotency per reserve state, contract ownership, balances from Postgres, inbox retries, exact grants).

## 1. Behaviour

Payments is the only service that changes a coin balance. Everyone else reads a balance and sends commands.

- **Ledger.** Double-entry in Postgres (the payments database), integer amounts, currency `COIN`.
  One wallet per (tenant, player), made of two accounts (`player_available`, `player_held`), plus two
  tenant system accounts (`tenant_issuance`, `tenant_redeemed`). Every movement is one journal
  transaction with two or more legs; a materialised balance per account is updated in the same
  database transaction. The journal is append-only; corrections are new transactions.
- **Spin credit (D-1).** There is no credit route. Engagement writes `engagement.spin.completed`
  (`spin_id`, `player_id`, `reward_coins`, optional `table_version`; tenant in the envelope) to its outbox.
  Payments consumes it through its inbox: in ONE transaction it inserts the inbox row, credits
  `reward_coins` (journal `spin_award`, `operation_id = spin_id`) and meters the spin. Delivery is at
  least once; the effect happens exactly once. The spin response carries the reward, not the balance.
- **Commands** (internal HTTP, service identity only): `reserve` (a redemption holds coins), then `capture`
  (the coins are spent) or `release` (the coins come back), and `refund` (a captured reserve is returned).
  Each has its own idempotency key and acts on an explicit reserve id chosen by the caller. Reserve
  is synchronous, so insufficient funds is an immediate 409 `insufficient_funds` (D-8).
- **Command paths read Postgres, never the cache (D-9).** A command, and the spin credit, never read,
  write or invalidate Redis and work while it is down.
- **Read.** `GET /v1/me/balance` (player), `GET /v1/players/:player_id/balance` (operator). A Redis
  projection (`tenantCacheKey(tenant, 'balance', walletId)`) serves reads; it is eventually consistent,
  refreshed by `onCoinEvent`, and falls back to the database when Redis is down.
- **Events** (outbox, same transaction): `payments.coins.credited`, `.reserved`, `.captured`,
  `.released`, `.refunded`. Payments owns these names and the rejection codes (section 3); L4 adopts them.
- **Reconciliation.** A per-tenant job recomputes every account balance from its legs, checks every
  transaction balances and each reserve's state against its transactions (an orphan hold included),
  writes a durable run record and a conservation report. It never repairs.
- **Billing (operator).** Plans (`free`, `pro`, `scale`, integer cents), a subscription per tenant, an
  invoice per charge, through a `PaymentProvider` port. A subscription is `pending` until a VERIFIED
  provider webhook says `active`; an older provider version never overwrites a newer one. Default adapter
  `fake` (token `tok_4242` accepted, `tok_0002` declined). The `stripe` adapter is a stub selected by
  `STRIPE_SECRET_KEY`; every method throws `NotConfiguredError`.
- **Usage metering.** The inbox handler counts `engagement.spin.completed` per tenant and calendar month:
  spins and distinct players (monthly active players), unless the producer marked the envelope `sandbox`.
  A report per period is sent to the provider once.
- **Erasure.** The player-to-wallet link (`wallet_owner_links`) can be deleted. The wallet id, accounts,
  balances and journal stay; no ledger or usage table carries a user id (MAU is keyed by a salted hash,
  `usage_players.player_key`). Event payloads carry `player_id`, which is the identity service's pseudonymous
  id; published outbox rows are purged by the foundation retention job. Owner question (open): whether that
  id must also be erased from events already consumed elsewhere.

## 2. State tables

**Reserve** (`reserves.state`, changed only by a conditional `UPDATE ... WHERE state = <expected>`). The
table is the contract constant `RESERVE_COMMAND_OUTCOMES` (pinned in `payments.contracts.test.ts`):

| State      | `capture`                  | `release`                  | `refund`                   |
| ---------- | -------------------------- | -------------------------- | -------------------------- |
| (none)     | `reserve_not_found`        | `reserve_not_found`        | `reserve_not_found`        |
| `reserved` | applies, -> `captured`     | applies, -> `released`     | `reserve_not_captured`     |
| `captured` | replay (stored result)     | `reserve_already_captured` | applies, -> `refunded`     |
| `released` | `reserve_already_released` | replay (stored result)     | `reserve_already_released` |
| `refunded` | `reserve_already_refunded` | `reserve_already_refunded` | replay (stored result)     |

**Idempotency is by the state of the reserve (D-9).** A repeat of an already applied transition returns the
stored result (same `transaction_id`, no new journal row, no new event), even under a NEW HTTP key and after
the HTTP record expired. Only a conflicting transition is refused. Two parallel conflicting commands
(capture against release) produce exactly one transition; the loser gets the conflict code, the others
of the winning kind the stored result. `reserve` repeats the same way, by `reserve_id`: the same id with
another amount or player is `operation_conflict`.

**Legs per command** (debit side first; amount = the command's or the reserve's amount):

| Command | operation_type | debit              | credit             |
| ------- | -------------- | ------------------ | ------------------ |
| spin    | `spin_award`   | `tenant_issuance`  | `player_available` |
| reserve | `reserve`      | `player_available` | `player_held`      |
| capture | `capture`      | `player_held`      | `tenant_redeemed`  |
| release | `release`      | `player_held`      | `player_available` |
| refund  | `refund`       | `tenant_redeemed`  | `player_available` |

Balances are `credits - debits` for player accounts and `tenant_redeemed`, `debits - credits` for
`tenant_issuance`; all are `>= 0`. Conservation: `issued = available + held + captured - refunded`.

**Subscription:** `pending` (provider accepted the token, nothing granted), `active`, `past_due`, `canceled`
(each only from a verified webhook), `declined` (the provider refused the token synchronously; the row and a
`failed` invoice exist for the audit trail). **Invoice:** `paid` (from the `active` webhook) or `failed`.
**Reconciliation run:** `ok`, `mismatch` (at least one mismatch), `failed` (the run did not complete).

## 3. API and event contracts

Schemas: `packages/contracts/src/payments.ts`. All routes parse input with them (`parseInput`).

| Route                                                             | Who                  | Body                                   | Success                   |
| ----------------------------------------------------------------- | -------------------- | -------------------------------------- | ------------------------- |
| `POST /internal/v1/tenants/:tenantId/reserves`                    | service `engagement` | `ReserveCoinsRequest` (with `sandbox`) | 201 `CoinOperationResult` |
| `POST /internal/v1/tenants/:tenantId/reserves/:reserveId/capture` | service `engagement` | `ReserveRefRequest` (empty)            | 200/201                   |
| `POST /internal/v1/tenants/:tenantId/reserves/:reserveId/release` | service `engagement` | `ReserveRefRequest` (empty)            | 200/201                   |
| `POST /internal/v1/tenants/:tenantId/reserves/:reserveId/refund`  | service `engagement` | `ReserveRefRequest` (empty)            | 200/201                   |
| `GET /internal/v1/tenants/:tenantId/players/:playerId/balance`    | service `engagement` | none                                   | 200 `WalletBalance`       |
| `GET /v1/me/balance`                                              | player               | none; the player is the principal      | 200 `WalletBalance`       |
| `GET /v1/players/:player_id/balance`                              | operator             | none                                   | 200 `WalletBalance`       |
| `GET /v1/billing/plans`                                           | operator             | none                                   | 200 `BillingPlan[]`       |
| `POST /v1/billing/attempts`                                       | operator             | `CreateAttemptRequest`                 | 201 `PaymentAttempt`      |
| `GET /v1/billing/attempts/:id`                                    | operator             | none                                   | 200 `PaymentAttempt`      |
| `POST /v1/billing/attempts/:id/cancel`                            | operator             | none (Idempotency-Key)                 | 200 `PaymentAttempt`      |
| `GET /v1/billing/subscription`                                    | operator             | none                                   | 200 `Subscription` / null |
| `GET /v1/billing/invoices`                                        | operator             | none                                   | 200 `Invoice[]`           |
| `GET /v1/billing/usage?period=YYYY-MM`                            | operator             | none                                   | 200 `UsageReport`         |
| `POST /v1/billing/webhooks`                                       | the provider         | raw JSON, `x-webhook-signature`        | 200 `WebhookResult`       |

- **Payment attempt (operator checkout; coordinator addition).** `POST /v1/billing/attempts` creates an
  attempt for a plan from a test card number and starts the provider subscription; `GET` reads its state;
  `POST .../cancel` cancels it. States `processing | succeeded | declined | cancelled`
  (`ALLOWED_ATTEMPT_TRANSITIONS`: only `processing` moves). `declined` is immediate (card `4000000000000002`);
  `succeeded` only from the verified activation webhook; `cancel` moves `processing` to `cancelled`, cancels the
  provider subscription, and is idempotent (a repeat answers `cancelled`); cancelling a `succeeded` or
  `declined` attempt is 409 `attempt_not_cancellable`. A cancelled attempt never captures: a later provider
  callback for it returns `ignored`, is recorded (so a redelivery is a duplicate) and changes nothing (no
  activation, no invoice). Cancel and success racing are decided by one conditional `UPDATE ... WHERE
state = 'processing'`. The fake provider accepts only test numbers (`4242424242424242` visa,
  `5555555555554444` mastercard, `4000000000000002` visa declined); any other number is 422
  `card_not_accepted`. The number is read only by the attempt controller and passed to the adapter's
  `tokenize`; nothing stores, hashes (the idempotency hash covers `plan_id` and the token only) or logs it; the
  attempt keeps `card_last4` and `card_brand`. The token-based `SubscribeRequest` stays an internal service call, not a route.
- The POST set of the whole application is exactly: the four coin commands, `attempts`, `attempts/:id/cancel`, `webhooks`. A
  route-table test over the REAL `createAppModule` fails on any other POST route. There is no credit route
  of any kind; the foundation's `POST /v1/credits` and its files are deleted.
- **Service identity (D-4, X-9, X-18).** There are no header placeholders (`x-service-id`, `x-service-token`,
  `x-principal-kind`, `x-acting-tenant`, `ServiceTokenGuard`, `SERVICE_TOKENS` are deleted). The internal
  routes are `PAYMENTS_INTERNAL_ROUTES` (declared once, in `identity.ts`, next to the allow-list): the tenant is in
  the path, the route accepts only a service token with `aud=payments`, and the callee-side allow-list
  (`SERVICE_CALL_POLICY`) admits only `svc:engagement`. A user token (operator, player, acting) is 401; a valid
  service token of another caller (`svc:identity`) is 403 `SERVICE_CALL_FORBIDDEN`. Capture, release and refund name
  the reserve in the path and carry an empty body. `ReserveCoinsRequest.sandbox` is required (no default): it is
  legal because the route is service-token only and engagement sets it from its own server-side auth context (X-4).
- **Sandbox wallets (X-2, D-13).** A player has one wallet per environment: `wallets(tenant_id, id, sandbox)` with
  `UNIQUE(tenant_id, user_id, sandbox)` on the owner link. A spin credit picks its wallet from `envelope.sandbox`; a
  reserve from the request flag; capture, release and refund use the reserve's own wallet. Balance reads take the
  environment from the token claim `sbx` (never a header or query) and answer the wallet of that environment. A
  reserve on the sandbox wallet cannot spend production coins, and a sandbox spin never credits the production wallet.
  Metering reads the envelope flag only and skips sandbox events.
- **Acting tenant (D-5, X-10, X-11, D-15 Q-2).** Payments keeps one guard, on user-mode routes, as defence in depth:
  `ActingCoinGuard` (`controllers/coin-action.ts`, with `@CoinAction(action)` and `@NoCoinEffect()`, pinned by
  `acting-ban.test.ts` and `wiring.test.ts`) reads `authOf(req).act` and answers 403 `acting_forbidden` (a payments
  code, lower-case) for every coin-value action, before the handler runs. The internal coin routes take service
  tokens, which carry no `act`, so the choke point where an acting user causes a coin command is engagement's operator
  resolve (D-15 Q-2 (a), engagement spec). The list of coin-value actions is the contract constant
  `COIN_VALUE_ACTIONS` (`credit`, `reserve`, `capture`, `release`, `refund`), the ONLY list (identity derives its
  action names from it), pinned by its own test. `credit` has no route; its only entry is the inbox.
- Every command needs `Idempotency-Key` (8..128 chars); a replay answers the stored status and sets
  `idempotent-replayed: true`. An in-flight duplicate is 409 (retryable), a changed body is 422 (D-3).
- **Error codes** (`PaymentsErrorBody { code, message }`): `validation_failed` 400,
  `idempotency_key_required` 400, `forbidden` 403, `acting_forbidden` 403 (X-10), `invalid_signature` 401 (webhook), `reserve_not_found` 404,
  `wallet_not_found` 404, `insufficient_funds` 409, `reserve_already_captured` 409,
  `reserve_already_released` 409, `reserve_already_refunded` 409, `reserve_not_captured` 409,
  `operation_conflict` 409, `idempotency_in_progress` 409, `idempotency_key_reused` 422,
  `attempt_not_found` 404, `attempt_not_cancellable` 409, `card_not_accepted` 422. These replace the
  single `invalid_reserve_transition`. An unexpected error is 500 and never a stored success; a webhook that
  fails after verification is 500, never 200, so the provider retries.
- **Events produced:** `payments.coins.credited` v1 (`credit_id` = journal transaction id, `player_id`,
  `amount`) and v1 of `.reserved`, `.captured`, `.released`, `.refunded` with `{ transaction_id, player_id,
wallet_id, reserve_id, amount, available_after, held_after }`.
- **Events consumed:** `engagement.spin.completed` v1 (owned by L3), through the inbox, consumer name
  `payments`. The envelope's `sandbox` flag is set by the producer from its server context.
- **Contract ownership (D-9).** L3 owns `spin.completed` and `casino-adapter.ts`; L2 (this area) owns the coin
  events, the reserve API and the rejection codes above; L4 imports them. `EventEnvelope.sandbox` is confirmed
  (D-13, FX-1) and lives in the foundation envelope.
- **Sandbox invariants (X-2):** INV-SBX-1..3 in `services/ledger.service.pgtest.ts`, and the rewritten sandbox case
  of INV-M5 in `usage.service.pgtest.ts`, pin the separate sandbox wallets.
- **Billing webhooks.** `PaymentProvider.verifyWebhook(rawBody, signature)` returns a `ProviderSnapshot`
  (`eventId`, `tenantId` echoed from our subscribe metadata, `subscriptionId`, `status`, monotonic
  `version`, `periodStart/End`) or throws `WebhookSignatureError`. Verification is the adapter's job, always
  on, and is the first thing the endpoint does; no environment flag exists to skip it.

## 4. Data model and database invariants

Tables, all with `tenant_id` and `ENABLE`+`FORCE` RLS plus one policy via `enableTenantRls`: `wallets(tenant_id, id, sandbox)`,
`wallet_owner_links(tenant_id, wallet_id, user_id, sandbox)`, `accounts(tenant_id, id, kind, wallet_id, currency,
sandbox)`,
`balances(tenant_id, account_id, amount BIGINT)`, `journal_transactions(tenant_id, id, operation_type,
operation_id, currency, created_at, created_by)`, `ledger_entries(tenant_id, id, transaction_id, account_id,
direction, amount BIGINT, currency)`, `reserves(tenant_id, id, wallet_id, amount BIGINT, state, created_at
DEFAULT now(), state_changed_at DEFAULT now())`, `reconciliation_runs`, `usage_events(tenant_id, spin_id, event_id,
occurred_at)` (primary key `(tenant_id, spin_id)`: a spin is metered once whatever event carries it, D-20),
`usage_meters`, `usage_players(tenant_id, period, player_key)`, `usage_reports`, `subscriptions`, `invoices`,
`payment_attempts(tenant_id, id, plan_id, subscription_id, state, card_last4, card_brand, created_at,
updated_at)` (no card number column),
`billing_webhook_events(tenant_id, provider, event_id)`, `idempotency_keys`. Tenant-less on purpose (the
whole list): `billing_plans`, `outbox`, `inbox`, `migrations`, `reconciliation_tenants(tenant_id)` (an id-only
registry filled when a tenant's first wallet is created or its first spin is metered, so the scheduled jobs can
list tenants without `BYPASSRLS`). The foundation's `coin_credits` is dropped by the migration `Ledger`.

**Provisioning (F7).** A wallet, its two accounts and the tenant's two system accounts of the environment are
created inside the first credit's transaction with `INSERT ... ON CONFLICT DO NOTHING` and a re-select, on
`UNIQUE (tenant_id, user_id, sandbox)` of the link, `UNIQUE (tenant_id, kind, sandbox) WHERE wallet_id IS NULL`
and `UNIQUE (tenant_id, wallet_id, kind)` of accounts. Parallel first credits never create a second wallet or
system account. Sandbox coins have their own `tenant_issuance` and `tenant_redeemed` accounts, so the
production conservation figures never include them; the reconciliation report shows production figures and its
`holds` is true only when the identity holds in both environments.

**Roles and grants (D-9, D-20: the foundation owner/app split).** `docker/postgres/init.sh` (foundation)
creates the roles `payments_owner` (owns the schema, used by `node dist/migrate.js` through
`MIGRATION_DATABASE_URL`) and `payments_app` (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS`, not a member of the owner, `GRANT CONNECT`, `DATABASE_URL`). Payments has no role scheme of its
own. ONE map, `PAYMENTS_APP_GRANTS` in the `AppRoleGrants` migration (it runs after `Ledger`, which creates the
tables), holds ALL table grants, exactly, plus `PAYMENTS_APP_COLUMN_UPDATES` for the column-level `UPDATE`s the
map cannot express. `ledger.schema.pgtest.ts` and `tests/compose` roles pin them: `SELECT, INSERT` on `accounts`, `balances`, `billing_webhook_events`, `idempotency_keys`, `inbox`,
`invoices`, `journal_transactions`, `ledger_entries`, `reconciliation_runs`, `reconciliation_tenants`,
`reserves`, `usage_events`, `usage_players`, `usage_reports`, `wallets`; `SELECT` on `billing_plans`;
`SELECT, INSERT, UPDATE` on `outbox`, `payment_attempts`, `subscriptions`, `usage_meters`; `SELECT, INSERT, DELETE` on
`wallet_owner_links`; column-level `UPDATE (amount)` on `balances` and `UPDATE (state, state_changed_at)` on
`reserves`. Nothing else: no `TRUNCATE`, no `UPDATE`/`DELETE` on the journal, nothing to PUBLIC, no privilege
on `migrations`, no `CREATE` on the schema. The `payments_owner` role owns the tables; `migrate` connects as it.

Constraints: `UNIQUE (tenant_id, operation_type, operation_id)` on `journal_transactions`;
`CHECK (amount > 0 AND amount <= 1000000000000)` on entries and reserves; `CHECK (amount >= 0)` on
balances; deferred constraint triggers (`journal_balanced`) on `journal_transactions` and `ledger_entries`:
every transaction has >= 2 legs (`fewer than 2 legs`), debits equal credits (`not balanced`), leg currency =
transaction currency = account currency (`currency mismatch`), and a leg cannot be added to a transaction
committed earlier (`transaction is sealed`). The messages are pinned by tests, so a bare CHECK cannot stand in
for the trigger. Account currency has no CHECK of its own.

## 5. Ledger commands and the spin handler

Each command runs inside `Db.idempotent` and, in that one transaction: inserts the journal transaction and
legs, applies the balance changes with conditional relative updates (`UPDATE balances SET amount = amount - $n
WHERE ... AND amount >= $n`; credits add; no absolute write; a decision is never made from a value read
earlier), changes the reserve state with `WHERE state = <expected>`, enqueues the event, stores the idempotency
record. The durable id of a business operation (`spin_id`, `reserve_id`) is the `operation_id`; a unique
violation on it is answered with the existing transaction (same parameters) or `operation_conflict`
(different). The HTTP record is only a response cache. Every statement is parameterised; interpolating a value
into SQL is forbidden by a source scan.

`PaymentsInboxHandler.handle(manager, event)` is the `EventHandler` given to `InboxConsumer`. For
`engagement.spin.completed` it runs, in the consumer's transaction, the spin credit (skipped when
`reward_coins = 0`) and `UsageService.handle`. Any other type is a permanent error. The same spin under a new
`event_id` returns the existing award; with other parameters it throws `operation_conflict` (dead letter).

**Fault hook.** `LEDGER_FAULTS.hit(point, manager)` is async, no-op in production, and receives the
transaction. It is called after the write it is named for, inside that transaction: `after_inbox` (first thing
in the handler, after the consumer's inbox insert), `after_journal` (journal row and legs), `after_balance`
(balance updates), `after_outbox` (event enqueued), `webhook_apply` (after the dedupe row and the subscription
change), `after_usage_report_sent` (after the provider call, before the `usage_reports` insert) and
`reconciliation_scan`. The test harness implements the hook and, before throwing, proves through the passed
transaction that the preceding write is visible there and not yet committed; a hook placed too early fails
every rollback test.

**Transient inbox errors (D-9).** A transient error (connection, timeout, deadlock, serialization failure,
SQLSTATE class 08, 40001, 40P01, 57P01) must not lose coins: the foundation `bus` change retries with bounded
backoff and only a permanent error or retry exhaustion goes to the DLQ, which has a replay command. That change
lives in `packages/bus` and is folded into the foundation fixes; until it merges, `D1-7` stays red. This area
pins the payments side: a transient failure is not dead-lettered and the redelivery applies once.

**Pool.** `makeDataSource({ poolMax?, logger? })` (default `poolMax` from `PG_POOL_MAX`, 10) so the tests can run
the same code with one connection and capture its SQL.

## 6. Balance read (`BalanceService`)

`readByPlayer(playerId)` and `readByWallet(walletId)` return `WalletBalance`; the wallet is looked up inside
the tenant transaction (`wallet_not_found` otherwise). The cache (`BALANCE_CACHE`, a `RedisCache`) is used
only here; a cache error is swallowed and the database answers. `onCoinEvent(event)` deletes the wallet's
key. Commands and the spin handler never receive or use the cache.

## 7. Reconciliation (`ReconciliationService`)

`run()` for the ambient tenant: recompute `credits - debits` per account and compare with `balances`
(`balance_drift`, `account_id`), re-check each transaction balances (`unbalanced_transaction`,
`transaction_id`), compare each reserve's state with its transactions, including a reserve with no reserve
transaction, an orphan hold (`reserve_state_drift`, `reserve_id`). It writes a `reconciliation_runs` row and
returns a `ReconciliationRun` with the `ConservationReport`. An exception inside the scan yields a run with
status `failed`, not a throw and not `ok`. `last()` returns the latest run plus `stale: true` when it
finished more than 2 hours ago. `runAll()` takes no tenant context, reads `reconciliation_tenants` and runs
each tenant in its own tenant transaction; one tenant's failure does not stop the others. It never writes to
`balances`.

**Callers of the jobs (D-20).** `LedgerJobsService.runOnce(now)` is one pass: `runAll()` for every tenant, then the
usage report of the last complete UTC month (`UsageService.reportDue`, only for a tenant with an active
subscription, under the stable provider key). It runs under a database advisory lock, so replicas never run it
twice; a pass that finds a mismatch calls the error reporter (the alert) and returns `attention: true`. Two
callers: the worker (`worker/ledger-worker.ts`, in the service process, every `LEDGER_JOBS_INTERVAL_SECONDS`,
default 3600, 0 = off, first pass one interval after start) and the command `node dist/ledger-report.js`
(`pnpm --filter @ex-mio/payments ledger:report`), which prints the runs and exits 0 (all ok), 1 (a mismatch or a
failed run) or 3 (the lock is held elsewhere). The run record is read on `GET /v1/platform/ledger/reconciliation`
(role `platform_admin`, acting inside the tenant because the record is tenant data under row-level security):
`{ last_run }` with the time, accounts checked, mismatches by kind, the conservation report and `stale`. A
cross-tenant overview is out of scope. Tests: `worker/ledger-worker.test.ts`, `controllers/ledger-admin.controller.test.ts`,
`services/ledger-jobs.service.pgtest.ts`.

## 8. Usage metering (`UsageService`)

`handle(manager, event)`: if `event.sandbox === true` return (a sandbox event is neither counted nor stored;
the flag comes ONLY from the envelope, never from a payload `test`/`sandbox` marker, and no route accepts
one). Otherwise insert `(tenant_id, spin_id)` into `usage_events` (conflict = already counted: a spin that engagement
re-publishes under a NEW `event_id`, or stamps in a later month, is not counted again; the first event decides the
period), increment the `spins` meter and record `(period, player_key)` for MAU, period = UTC `YYYY-MM` of `occurred_at`.
`report(period)` returns `UsageReport`. `reportToProvider(period)` requires an active subscription, sends the
quantity once with the stable key `usage:<tenant>:<period>`, then records it in `usage_reports`; a crash
between the two is repaired by the retry because the key is stable.

## 9. Billing and the provider port

`PaymentProvider` (`services/providers/payment-provider.ts`, token `PAYMENT_PROVIDER`): `kind`,
`tokenize(card)` (test cards only; returns `{ token, brand, last4 }`; otherwise throws, mapped to `card_not_accepted`),
`createCustomer`, `subscribe` (`pending` with a subscription id, or `declined`; never `active`),
`verifyWebhook`, `getSubscription`, `cancelSubscription`, `reportUsage` (idempotent per key).
`FakePaymentProvider({ webhookSecret })` signs and verifies with HMAC-SHA256, exposes `sign`, `checkouts()`
and `recordedUsage()` for tests. `StripePaymentProvider` throws `NotConfiguredError`. `selectPaymentProvider(env)`
(fake unless `STRIPE_SECRET_KEY` is non-empty; read once at start-up). No Stripe name or import appears
outside `stripe.provider.ts`.

`BillingService`: `listPlans`; `createAttempt`, `getAttempt`, `cancelAttempt` (section 3; the attempt wraps
`subscribe` and `handleWebhook` resolves it from the provider subscription id); `subscribe(request, key)` (idempotent, `validation_failed` for an unknown plan;
the provider is priced from the plan row); `handleWebhook(rawBody, signature)` verifies, then in ONE tenant
transaction inserts the `billing_webhook_events` row (conflict = `duplicate`), applies the snapshot with
`UPDATE ... WHERE provider_version < $new` (not applied = `superseded`, still recorded), creates the paid
invoice for an `active` snapshot from the subscription's PLAN ROW (never the provider's claimed amount), and
calls `webhook_apply`; `currentSubscription` (latest `pending`/`active`/`past_due`, else null); `listInvoices`.
There is one tariff map: the seeded `billing_plans` (`free` 0, `pro` 4900, `scale` 19900 USD cents); no plan
code or price literal appears in source outside the migrations.

## 10. Invariants, choke points and tests

All pgtests need Postgres (section 12); `*.test.ts` run without it.

| Invariant                                                                                      | Backlog criterion                          | Choke point                                          | Test                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| INV-L1 balanced legs, currency, sealed transaction, by the DB                                  | MIO-081; MIO-150-18                        | trigger `journal_balanced`                           | `model/ledger.schema.pgtest.ts`                                                                |
| INV-L2 journal append-only; app role not owner                                                 | MIO-081 permission error                   | grants, role                                         | same                                                                                           |
| INV-L2b exact `payments_app` grants (D-9)                                                      | D-9                                        | migration `Ledger`                                   | same                                                                                           |
| INV-L3 one transaction per business operation                                                  | MIO-081 duplicate award; MIO-150-16        | unique constraint                                    | same                                                                                           |
| INV-L4 no negative balance                                                                     | MIO-081                                    | CHECK on `balances`                                  | same                                                                                           |
| INV-L5 integer amounts, cap, no float columns                                                  | MIO-081 boundaries, MIO-150-08             | CHECKs, column types                                 | same; `contracts/payments.contracts.test.ts`                                                   |
| INV-L6 RLS on every tenant table, by catalog                                                   | MIO-032                                    | `enableTenantRls`                                    | same                                                                                           |
| INV-L7 one wallet, one link, one system account per tenant                                     | F7                                         | unique constraints                                   | same                                                                                           |
| INV-O1/O2/O3 erasure keeps the account; no user id in ledger or usage                          | area spec                                  | schema; `eraseIdentityLink`                          | same; `ledger.service.pgtest.ts`; `usage.service.pgtest.ts`                                    |
| INV-C1 concurrent reserves never overspend (pool >= 10, overlap proven)                        | MIO-082 50 parallel, MIO-150-17            | conditional UPDATE                                   | `services/ledger.service.pgtest.ts`                                                            |
| INV-C1b same with one connection, caught from the SQL                                          | F14                                        | conditional relative UPDATE                          | same                                                                                           |
| INV-C2 mixed concurrency conserves                                                             | MIO-082, MIO-150-05                        | conditional UPDATE                                   | same                                                                                           |
| INV-I1 same key replays once                                                                   | MIO-082                                    | `Db.idempotent`                                      | same                                                                                           |
| INV-I2 changed body 422                                                                        | MIO-082, MIO-086                           | request hash                                         | same                                                                                           |
| INV-I3 replay after record expiry, every phase                                                 | MIO-086, MIO-150-16                        | unique `operation_id`, parameter compare             | same                                                                                           |
| INV-I4 one operation under 10 parallel keys                                                    | F17                                        | unique `operation_id`                                | same                                                                                           |
| INV-T1 transitions follow `RESERVE_COMMAND_OUTCOMES`, specific codes                           | MIO-082; D-9                               | conditional state UPDATE                             | same; `payments.contracts.test.ts`                                                             |
| INV-T2 each phase idempotent by reserve state, any key                                         | MIO-066, MIO-150-15; D-9                   | per-phase operation key, state                       | same                                                                                           |
| INV-T3 explicit reserve id                                                                     | area spec                                  | command body, unique `operation_id`                  | same                                                                                           |
| INV-T4 capture and release race: one transition wins                                           | F6                                         | conditional state UPDATE                             | same                                                                                           |
| INV-A1 rollback together, hook placement proven (4 phases x 3 points)                          | MIO-082 three tests, MIO-150-06/19         | one transaction, harness-driven hook                 | same                                                                                           |
| INV-E1 event per phase, same tx, none on a replay                                              | MIO-082                                    | `Db.publish` in effect                               | same                                                                                           |
| INV-X4 no SQL interpolation; hostile key stored verbatim                                       | MIO-150-12                                 | parameters; source scan                              | same; `source-rules.test.ts`                                                                   |
| D1-1..D1-13 spin credit through the real `InboxConsumer`                                       | D-1; MIO-082, MIO-084, MIO-086, MIO-150-20 | inbox handler, journal unique                        | `services/spin-credit.consumer.pgtest.ts`                                                      |
| INV-B1..B3 fresh read, Redis down, tenant-scoped cache, commands never use it                  | MIO-083; D-9                               | `BalanceService`, `tenantCacheKey`                   | `services/balance.service.pgtest.ts`                                                           |
| INV-B4 own balance only                                                                        | MIO-083                                    | controller principal                                 | `controllers/coins.controller.test.ts`                                                         |
| INV-X1 route table exact; only `engagement` moves coins; no public credit                      | MIO-082, MIO-150-02                        | service-kit entry point, real route table            | same                                                                                           |
| INV-X5 acting tenant refused, action list pinned                                               | D-5                                        | `ActingCoinGuard`; `COIN_VALUE_ACTIONS`              | same; `payments.contracts.test.ts`                                                             |
| INV-X2 validation before service                                                               | MIO-081, MIO-150-08/13                     | zod `parseInput`                                     | same                                                                                           |
| INV-X3 defined error codes, every domain code                                                  | MIO-150-19                                 | controller exception mapping                         | same                                                                                           |
| INV-R1..R5 reconciliation: kinds, orphan hold, unbalanced, `runAll`                            | MIO-084, MIO-150-28                        | `ReconciliationService`                              | `services/reconciliation.service.pgtest.ts`                                                    |
| INV-M1..M3 metering                                                                            | MIO-095                                    | inbox handler, `usage_events` PK                     | `services/usage.service.pgtest.ts`                                                             |
| INV-M4 usage billed once, checked at the provider; crash after send                            | MIO-095                                    | stable idempotency key                               | same                                                                                           |
| INV-M5 sandbox flag from the producer only                                                     | MIO-095; L4 brief                          | `UsageService.handle`                                | same; `controllers/coins.controller.test.ts` (no route)                                        |
| INV-P1..P4 plans, tokens, idempotent subscribe, tenant isolation                               | MIO-091, 093, 098                          | `BillingService`                                     | `services/billing.service.pgtest.ts`                                                           |
| INV-P5/P6 one tariff map; no plan literal in source                                            | MIO-091, MIO-150-09                        | plan row, scan                                       | same; `source-rules.test.ts`                                                                   |
| INV-P7 card number read in one place, never persisted; fake takes test cards                   | F20; coordinator                           | `tokenize`, `CreateAttemptRequest`                   | `billing.service.pgtest.ts` (INV-A2); `source-rules.test.ts`; `payment-provider.test.ts` (PP5) |
| INV-A2 attempt lifecycle; cancelled never captures; late callback ignored; cancel/success race | coordinator                                | conditional state UPDATE, `handleWebhook`            | `services/billing.service.pgtest.ts`; `payments.contracts.test.ts`; `coins.controller.test.ts` |
| INV-W1 webhook: verified, deduped, ordered, errors not swallowed                               | MIO-093, MIO-150-01/04/06/07/11/14         | `handleWebhook`, conditional UPDATE                  | `services/billing.service.pgtest.ts`                                                           |
| INV-W2 billing routes, raw body, 401 vs 500                                                    | MIO-093, MIO-150-07                        | controller                                           | `controllers/coins.controller.test.ts`                                                         |
| INV-W3/W4 verification first, no env flag bypass                                               | MIO-150-01/10                              | provider adapter; real module with a failing DB stub | `controllers/billing.webhook.test.ts`; `source-rules.test.ts`                                  |
| INV-PP1..PP4 provider port, webhook verification                                               | MIO-090                                    | adapters, `selectPaymentProvider`                    | `services/providers/payment-provider.test.ts`                                                  |

MIO-150 rows: 01 W1/W3, 02 X1, 03 B4, 04 W1, 05 C2, 06 A1/W1, 07 W2/W3, 08 L5, 09 P5/P6, 10 W3/W4, 11 M1/W1,
12 X4, 13 X2, 14 P2/W1, 15 T2, 16 I3, 17 C1, 18 L1, 19 A1, 20 D1-1 (`known-payment-defect-20`), 21 X1, 22 I2,
24 M1, 28 R5. Rows 23 (retry/backoff) belong to L4; 25-27 (entitlements, MIO-096) are out of scope.

## 11. Out of scope

Hosted checkout page and entitlements (MIO-096); platform revenue view (MIO-099); player ledger history
(MIO-085) and the operator adjustment path with audit (MIO-161); the `HELD`-versus-redemption cross-check with
engagement in reconciliation (needs the engagement service); the real identity token (placeholder headers stay;
the acting-tenant check will read its claim); a real Stripe implementation; the Redis projection being fed by
the bus in production (`onCoinEvent` is the handler, wiring a queue binding is stage B); the DLQ replay command
and transient retry in `packages/bus` (foundation fix, folded in by the coordinator).

## 12. Running the tests and stage B notes

```sh
docker compose up -d --wait postgres          # init.sh creates payments_owner and payments_app
MIGRATION_DATABASE_URL=postgresql://payments_owner:payments-owner-dev@localhost:54329/payments pnpm --filter @ex-mio/payments migrate
pnpm --filter @ex-mio/payments test           # unit: controllers (real module), provider, source rules
pnpm --filter @ex-mio/payments test:db        # pgtests (need the database above)
```

Stage B must: add the `payments_app` role to `init.sh` and the compose `payments` service (`DATABASE_URL` as
`payments_app`, migrate as `payments`); write migration `Ledger` (all tables, uniques, triggers, the exact
grants, the plan seed; drop `coin_credits`); delete the foundation's `credits.*` files; give `makeDataSource`
its options; and add the modules the tests import: `ledger.module.ts`, `services/{ledger,balance,
reconciliation,usage,billing}.service.ts`, `services/inbox.handler.ts`, `services/ledger.errors.ts`,
`services/providers/*` (`payment-provider.ts` exporting `PAYMENT_PROVIDER`, `WebhookSignatureError`),
`controllers/{coins,balance,billing}.controller.ts`, `controllers/coin-action.ts` (the acting guard and its
decorators, see `acting-ban.test.ts`), `model/ledger.faults.ts`. There is no `service-token.guard.ts`: the app is
wired with `ServiceAuthModule.forService({ audience: 'payments', identityUrl })` only (`wiring.test.ts`), and the
HTTP tests (`testing/app.ts`) override just the `SERVICE_AUTH_OPTIONS` sources with the fixtures of
`testing/auth.ts`. `createAppModule(config)` reads `IDENTITY_URL`. It must register the
inbox handler for `engagement.spin.completed` (the bus binding) and start the app with `rawBody: true`.
The `payments_app` grants are listed in ONE migration, folded into the foundation `AppRoleGrants` migration
(foundation grants `coin_credits`, which this area drops: remove it there, `roles.compose.test.ts` pins it), and
`wallets` gains `sandbox` (X-2). `seedCoins` (`tests/compose/src/seed-coins.ts`, owned by this area, X-3 of the
reconciliation section 3) funds players in compose tests through a real `spin.completed` publish.
