# Product analytics

Every product event goes to Varta, one panel. A service writes one JSON line per event to stdout, next
to its ordinary log lines. The log collector routes lines with `"kind":"product_event"` to Varta's
`product_events` stream. Nothing in MIO talks to Varta at runtime.

## The line

The envelope is Varta's product-event schema (decision D-19), vendored verbatim in
`packages/contracts/schemas/varta-product-event.schema.json`. The source commit is in
`varta-product-event.schema.SOURCE` next to it, with the file's hash; a test fails if they drift.

```json
{
  "ts": "2026-11-21T10:11:12.345Z",
  "level": "info",
  "service": "payments",
  "env": "production",
  "version": "1.4.2",
  "kind": "product_event",
  "event": "payments.payment_succeeded",
  "event_v": 1,
  "event_id": "01a1fd96-ab59-701a-901b-000000000001",
  "tenant_id": "<tenant uuid>",
  "actor_type": "service",
  "actor_id": "payments",
  "consent": "essential",
  "props": { "plan_code": "starter", "amount_minor": 4900, "currency": "EUR" }
}
```

Rules, all checked when the line is built (`buildProductEvent` in `packages/contracts`) and again
against the schema with ajv in the tests:

- closed key list; `event` is `domain.object_action`, lower case, past tense;
- `event_id` is a fresh lower-case UUIDv7; `tenant_id` is always present;
- exactly one of `actor_id` (an internal id, never starting with `anon:`) and `anon_id`;
- ids are ASCII `[A-Za-z0-9._:|/+=~-]`, so an email cannot be an id;
- `props` is a flat map of strings, numbers and booleans. Keys are `snake_case`, with no `varta_`
  prefix and no PII-shaped name (`email`, `phone`, `ip`, `token`, `*_email`, ...). String values are an
  ALLOW-list, not a deny-list: every character must be in `A-Z a-z 0-9 space _ . : / [ ] ( ) -`, at most 256
  characters, and no run of 9 or more digits. So an email (with or without a trailing `#`, zero-width
  space or percent-encoding), a URL query, a bearer token (commas, `=`), JSON or `util.inspect` text and
  non-ASCII digits (Arabic-Indic phone numbers) are all refused. This is stricter than the vendored Varta
  schema, which a stricter producer still satisfies (D-19). A refused event is dropped whole (one
  `product_event_dropped` warn line); no key or value is ever rewritten;
- money is `amount_minor` (an integer in the minor unit) plus `currency`;
- one line is at most 8 KiB.

`consent` is `essential` unless an emitter says otherwise: MIO has no analytics-consent flow yet, so
no event claims `analytics`.

## How a service emits

`@ex-mio/logger` exports `emitProductEvent`, `emitProductEventAs(authContext, ...)` and
`afterCommit(tx, fn)`. A service calls them from its service layer, never from a controller:

- **after the commit.** Inside a database transaction the emitter goes through `afterCommit(tx, ...)`:
  it runs when the transaction commits and is dropped on a rollback. A replayed idempotent request
  never ran its effect, so it emits nothing. Where the store owns its transaction (identity's unit of
  work, the redemption store) the call sits after the awaited write;
- **actor and tenant** come from the verified `AuthContext`. Where no request exists (the inbox
  consumer, the sweeper, a provider webhook, a launch token not yet exchanged) the actor is the
  internal player id or the service name, and the tenant is the tenant of the business row;
- **never throws.** A bad event is dropped and one `product_event_dropped` warn line is written, so
  analytics cannot fail a request that already committed. The tests turn that warn line into a failure;
- **no PII.** No email, no casino-side player id, no token, no key. Players are the internal uuid.

Each service's `main.ts` points the emitter at its named logger, so lines carry `service`.

## Event catalogue

| Event                             | Funnel step                   | Props                                                                                      | Emitter                                                                                             |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `identity.operator_signed_up`     | operator signs up             | `role`                                                                                     | `StaffService.signUpOperator`, after the commit                                                     |
| `identity.credential_issued`      | operator gets a casino key    | `environment`, `rotated`                                                                   | `CredentialsService.issue` and `rotate`, after the commit                                           |
| `identity.player_launched`        | player enters from the casino | `sandbox`, `new_player`                                                                    | `LaunchService.exchange`, after the session is issued                                               |
| `web.widget_opened`               | widget opened                 | `launched`                                                                                 | web BFF `POST /api/widget/opened`; anonymous (`anon_id`) before a launch, the verified player after |
| `payments.plan_selected`          | operator picks a plan         | `plan_code`, `amount_minor`, `currency`                                                    | `BillingService.start`, after the commit                                                            |
| `payments.payment_succeeded`      | plan paid                     | `plan_code`, `amount_minor`, `currency`                                                    | `BillingService.applyWebhook`, after the commit; priced from our plan row                           |
| `payments.payment_failed`         | plan not paid                 | `plan_code`, `amount_minor`, `currency`, `reason` (`declined`, `past_due`)                 | `BillingService.start` (card refused), `applyWebhook` (past due)                                    |
| `engagement.deposit_ingested`     | player deposits at the casino | `casino`, `sandbox`, `amount_minor`, `currency`                                            | `IngestionService.ingest`, after the commit, only for a new deposit                                 |
| `payments.coins_credited`         | coins reach the wallet        | `source` (`spin`), `coins`, `sandbox`                                                      | `LedgerService.creditSpin`, after the inbox commit                                                  |
| `engagement.spin_completed`       | player spins                  | `reward_coins`, `sandbox`                                                                  | `SpinService.spin`, after the commit, not on a replay                                               |
| `engagement.redemption_requested` | player orders a reward        | `price_coins`, `sandbox`                                                                   | `RedemptionSagaService.redeem`, after `placeOrder`                                                  |
| `engagement.redemption_resolved`  | order reaches an end          | `status` (`completed`, `released`, `refunded`, `rejected_funds`), `price_coins`, `sandbox` | `RedemptionSagaService` state change that applied                                                   |

`coins_credited` has one source today, a spin. A deposit does not credit coins by itself: it grants
spins. When another source appears it adds a value to `source`, not a new event.

## Funnels these answer

- **Operator activation.** `operator_signed_up` -> `credential_issued` -> first `deposit_ingested` of
  that tenant. Where operators stall before the casino is connected.
- **Operator revenue.** `plan_selected` -> `payment_succeeded`, with `payment_failed` by `reason`.
  Conversion to paid, and failures that are declines against dunning.
- **Player loop.** `widget_opened` (anonymous) -> `player_launched` -> `deposit_ingested` ->
  `spin_completed` -> `coins_credited` -> `redemption_requested` -> `redemption_resolved`. Where players
  drop, and how many orders end in `completed` rather than `released` or `rejected_funds`.
- **Sandbox against production.** Every player and money event carries `sandbox`; filter it out of
  revenue and engagement numbers.

Varta never merges an anonymous visitor with a known player, so the anonymous `widget_opened` step and
the `player_launched` step are counted as two populations, not joined per person.

## Captured example

One clean `docker compose up` followed by `scripts/demo.sh` (two operators, one player each plus a second
player in casino A, a 3-times-delivered duplicate deposit, a 10-way spin race, a 5-way same-key redemption).
The lines were collected from the services' stdout with `docker compose logs`, filtered on
`"kind":"product_event"` (29 lines), and counted per event and tenant. Tenant A is the casino A operator,
tenant B the casino B operator.

| Funnel step                   | Event                             | Tenant A | Tenant B | Note                                                                         |
| ----------------------------- | --------------------------------- | -------: | -------: | ---------------------------------------------------------------------------- |
| operator signs up             | `identity.operator_signed_up`     |        1 |        1 |                                                                              |
| operator picks a plan         | `payments.plan_selected`          |        1 |        1 |                                                                              |
| plan paid                     | `payments.payment_succeeded`      |        1 |        1 |                                                                              |
| operator gets a casino key    | `identity.credential_issued`      |        1 |        1 |                                                                              |
| player enters from the casino | `identity.player_launched`        |        4 |        2 | two launches per player (one token per audience)                             |
| player deposits at the casino | `engagement.deposit_ingested`     |        2 |        1 | tenant A received 4 deliveries of 2 deposits: one deposit came 3 times       |
| player spins                  | `engagement.spin_completed`       |        2 |        1 | the 10-way race produced exactly one spin                                    |
| coins reach the wallet        | `payments.coins_credited`         |        2 |        1 |                                                                              |
| player orders a reward        | `engagement.redemption_requested` |        4 |        1 | 5 parallel same-key requests are one order                                   |
| order reaches an end          | `engagement.redemption_resolved`  |        1 |        0 | the one `rejected_funds` (a player with no coins); see the README known gaps |

Operator activation is 2 of 2 operators through signup, plan, payment and key. The player loop of tenant A
runs 4 launches, 2 deposits, 2 spins, 2 credits and 4 orders. Two lines as emitted:

```json
{"level":"info","service":"engagement","kind":"product_event","event":"engagement.deposit_ingested","event_v":1,"tenant_id":"<tenant uuid>","actor_type":"player","actor_id":"<player uuid>","consent":"essential","props":{"casino":"casino-a","sandbox":false,"amount_minor":5000,"currency":"EUR"}}
{"level":"info","service":"engagement","kind":"product_event","event":"engagement.deposit_ingested","event_v":1,"tenant_id":"<tenant uuid>","actor_type":"player","actor_id":"<player uuid>","consent":"essential","props":{"casino":"casino-b","sandbox":false,"amount_minor":5000,"currency":"EUR"}}
```

## Known limits

- The web BFF reads the tenant of an anonymous `widget_opened` from the launch token's key id,
  unverified (nothing can verify it before the exchange). A forged key id can add anonymous rows to
  some tenant. The event is not used for money.
- The embedded widget calls `POST /api/widget/opened` once per mount (`useWidgetOpened`). The launch
  token comes from the page's `?token=` query parameter; without it, and without a player session,
  the BFF has no tenant to name and writes nothing. The browser launch flow itself
  (`/api/session/launch`) still has no caller.
- The commit hook is TypeORM's transaction subscriber, registered on first use. The tests drive it with
  a stand-in transaction that calls the same subscriber methods; a Postgres run was not part of this change.
