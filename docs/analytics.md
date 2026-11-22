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
  prefix and no PII-shaped name (`email`, `phone`, `ip`, `token`, `*_email`, ...). A string value that
  is an email address or JSON text is refused;
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
