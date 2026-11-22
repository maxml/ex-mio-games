# Architecture diagrams

Five diagrams (the ERD is drawn as an overview plus one page per database), each kept as a typed archify IR file (`*.json`), a rendered interactive page (`*.html`), and a Mermaid copy below that renders inline on any git host. The prose is in [overview.md](overview.md); decisions are in [`docs/adrs/`](../adrs/).

| Diagram                                      | Interactive page                           | Typed source                               |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Context and containers                       | [architecture.html](architecture.html)     | [architecture.json](architecture.json)     |
| Sequence: the 8-step workflow                | [sequence.html](sequence.html)             | [sequence.json](sequence.json)             |
| Workflow: redemption saga with compensations | [workflow.html](workflow.html)             | [workflow.json](workflow.json)             |
| ERD: overview of the three databases         | [erd.html](erd.html)                       | [erd.json](erd.json)                       |
| ERD: identity (13 tables)                    | [erd-identity.html](erd-identity.html)     | [erd-identity.json](erd-identity.json)     |
| ERD: engagement (15 tables)                  | [erd-engagement.html](erd-engagement.html) | [erd-engagement.json](erd-engagement.json) |
| ERD: payments (22 tables)                    | [erd-payments.html](erd-payments.html)     | [erd-payments.json](erd-payments.json)     |
| Lifecycle: redemption states                 | [lifecycle.html](lifecycle.html)           | [lifecycle.json](lifecycle.json)           |

The HTML pages are standalone files; open them locally in a browser (a git host shows their source, not the page).

## Why each diagram exists

Each diagram answers one question. The table links the question to the Part A items of the task, the decisions
behind it and the reliability cases it shows. To go from a document to a picture, follow the "Diagram:" line at
the top of every ADR, of the overview and of the specs. Each picture below is a PNG render; the interactive
page is the `*.html` file next to it (see [View it locally](#view-it-locally)).

| Diagram                                                                     | Question it answers                                                                                                     | Part A items                                                                                                            | ADRs                                                                                                                                                                                                                                                                                                                                                                       | Specs                                                                                                                                                                    | Part C                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [Context and containers](#1-context-and-containers)                         | What are the parts and who talks to whom?                                                                               | tenant isolation, integration layer, identity mapping, ledger, admin configuration (web console), observability (Varta) | [0001](../adrs/0001-microservices-and-their-cost.md), [0002](../adrs/0002-tenancy-model.md), [0003](../adrs/0003-rabbitmq-outbox-inbox.md), [0007](../adrs/0007-identity-interface-and-emulator.md), [0008](../adrs/0008-integration-adapters-canonical-model.md), [0009](../adrs/0009-analytics-via-varta.md), [0011](../adrs/0011-container-per-service-and-deckhand.md) | all five                                                                                                                                                                 | C-7 tenant isolation                                          |
| [Sequence: the 8-step workflow](#2-sequence-the-8-step-workflow)            | What happens, in order, from deposit to a tracked reward?                                                               | ingestion, validation and deduplication, identity mapping, ledger, redemption and delivery                              | [0003](../adrs/0003-rabbitmq-outbox-inbox.md), [0004](../adrs/0004-virtual-currency-ledger.md), [0005](../adrs/0005-rng-and-fairness.md), [0006](../adrs/0006-redemption-saga.md), [0008](../adrs/0008-integration-adapters-canonical-model.md)                                                                                                                            | [engagement-ingest](../specs/engagement-ingest.md), [identity](../specs/identity.md), [payments](../specs/payments.md), [engagement-store](../specs/engagement-store.md) | C-1 duplicate deposit, C-2 concurrent spins                   |
| [Workflow: redemption saga](#3-workflow-redemption-saga-with-compensations) | Which steps and compensations does a redemption run, and who owns each?                                                 | redemption and delivery                                                                                                 | [0006](../adrs/0006-redemption-saga.md), [0004](../adrs/0004-virtual-currency-ledger.md), [0008](../adrs/0008-integration-adapters-canonical-model.md)                                                                                                                                                                                                                     | [engagement-store](../specs/engagement-store.md), [payments](../specs/payments.md)                                                                                       | C-3 duplicate redemption, C-4 timeout, failed reward issuance |
| [ERD: the three databases](#4-erd-the-schema-of-the-three-databases)        | Which tables exist (50, in 3 databases), which carry the tenant (RLS) and `sandbox`, and how do ledger entries balance? | tenant isolation, ledger, identity mapping                                                                              | [0002](../adrs/0002-tenancy-model.md), [0004](../adrs/0004-virtual-currency-ledger.md), [0007](../adrs/0007-identity-interface-and-emulator.md)                                                                                                                                                                                                                            | [identity](../specs/identity.md), [payments](../specs/payments.md)                                                                                                       | C-6b no negative balance, C-7 tenant isolation                |
| [Lifecycle: redemption states](#5-lifecycle-redemption-states)              | Which states can a redemption be in, and which moves are allowed?                                                       | redemption and delivery                                                                                                 | [0006](../adrs/0006-redemption-saga.md)                                                                                                                                                                                                                                                                                                                                    | [engagement-store](../specs/engagement-store.md)                                                                                                                         | C-4 timeout and recovery, failed reward issuance              |

How to read them: solid arrows are synchronous calls, dotted arrows are events through the broker or
best-effort emissions. Boxes inside the platform frame are containers, one per service. In the saga and the
lifecycle the main path runs left to right and ends in `COMPLETED`; every other branch is a compensation or a
recovery path.

Part A items without a diagram of their own: the rules engine, admin configuration, and observability and security.
The context diagram shows them only as components (engagement, the web console, Varta). They are described in
[overview.md](overview.md), sections 12 and following, and in the specs, and no diagram is drawn for them.

## View it locally

The interactive pages are standalone HTML files with no server needed. Open one in a browser:

```sh
xdg-open docs/architecture/architecture.html   # Linux
open docs/architecture/architecture.html       # macOS
```

GitHub shows the source of an HTML file, not the page, so use the Mermaid blocks below or the PNG renders in
[`img/`](img/) when you read on GitHub. The PNG files are `architecture.png`, `sequence.png`, `workflow.png`,
`erd.png`, `erd-identity.png`, `erd-engagement.png`, `erd-payments.png` and `lifecycle.png`.

## Tooling and version

- Archify is a git submodule at `tools/archify`, pinned to tag `v3.2.0` (commit `208acba8d412335185b2056fedf54b3405df43fb`), Apache-2.0.
- `tools/archify-render.sh` validates and re-renders all eight IR files (the five diagrams, with the ERD as an overview and three per-database pages). `tools/archify-render.sh --check` validates only, for CI. Needs Node 18 or newer and `git submodule update --init tools/archify`.
- The Mermaid copies are written by hand and must agree with the IR files. When one changes, change the other (ADR 0012).
- Built, partial and next items are marked in [overview.md](overview.md#14-built-versus-designed). The Stripe adapter, websocket replay, the production identity provider, rate limiting and per-service deployment secrets are next, not built.
- The Mermaid copies and the IR files agree with the code. The `*.html` pages were re-rendered from the corrected IR with the pinned archify renderer. The ERDs were checked table by table against the migrations and against a live stack (`\dt`, `\d` in each database); the other diagrams were checked against `docker-compose.yml`, `packages/contracts` (events), the controllers (routes), `redemption-state.ts`, the saga service, the realtime gateway and `docs/observability/varta.md`.

## 1. Context and containers

![1. Context and containers](img/architecture.png)

Interactive page: [`architecture.html`](architecture.html), opened locally. Mermaid copy:

```mermaid
flowchart LR
  player([Player browser]) -->|HTTPS| web
  casino([casino-sim: Casino A and B]) -->|signed events, HMAC| engagement
  engagement -.->|issue reward, status| casino

  subgraph platform [MIO Games platform: one container per service]
    web[web: widget and operator console]
    identity[identity: authN, authZ, tenants module]
    engagement[engagement: ingestion, integrations module, rules, wheel, store, saga]
    payments[payments: ledger, coin operations, fake provider]
    rabbit{{RabbitMQ: outbox and inbox}}
    redis[(Redis: optional balance projection)]
    firebase[firebase-auth: identity provider emulator]
    idb[(Postgres: identity database)]
    edb[(Postgres: engagement database)]
    pdb[(Postgres: payments database)]
  end

  web -->|login, launch, realtime ticket| identity
  web -->|REST, websocket /rt| engagement
  identity -->|verify login| firebase
  engagement -->|resolve player, redeem ticket| identity
  engagement -->|sync coin reserve| payments
  identity --> idb
  engagement --> edb
  payments --> pdb
  identity -.->|tenant.created out, audit in| rabbit
  engagement -.->|events| rabbit
  rabbit -.->|spin.completed in, coin events out| payments
  payments -.->|balance projection| redis

  varta[[Varta: observability and analytics]]
  deckhand[[Deckhand: blue-green deploy]]
  identity -.->|stdout JSON lines, tailed from Docker logs, all four services| varta
  deckhand -.->|deploys containers| payments
```

## 2. Sequence: the 8-step workflow

![2. Sequence: the 8-step workflow](img/sequence.png)

Interactive page: [`sequence.html`](sequence.html), opened locally. Mermaid copy:

```mermaid
sequenceDiagram
  autonumber
  participant C as Casino A
  participant E as engagement
  participant I as identity
  participant P as payments
  participant U as Player (widget)

  C->>E: deposit event, HMAC signed (step 1)
  E->>I: resolve external player id (step 2)
  I-->>E: user_id
  E-->>C: 200 ack, a duplicate gets the same answer
  E-->>U: deposit.confirmed grants a spin, GET /v1/me/spins (step 3)
  U->>E: POST /v1/spins with Idempotency-Key (step 4)
  E-->>U: reward from the weighted table
  E-)P: engagement.spin.completed via outbox (step 5)
  P->>P: credit coins once (inbox), journal operation spin_award
  E--)U: websocket /rt: spin.result, balance.changed
  U->>E: POST /v1/redemptions, 202 (step 6)
  E->>P: POST /internal/v1/tenants/:id/reserves, key hold (sync)
  P-->>E: reserved, or 409 insufficient_funds
  E->>C: issue reward with our key (step 7)
  C-->>E: ok, or timeout then lookup by our key
  E->>P: POST .../reserves/:id/capture, key capture
  P-->>E: captured
  U->>E: GET /v1/redemptions/:id (step 8)
  E-->>U: ISSUED, then COMPLETED
```

## 3. Workflow: redemption saga with compensations

![3. Workflow: redemption saga with compensations](img/workflow.png)

Interactive page: [`workflow.html`](workflow.html), opened locally. Mermaid copy:

```mermaid
flowchart LR
  subgraph eng [engagement: saga owner]
    reserve["Reserve stock and limit (REQUESTED)"]
    request["Request issuance (ISSUING)"]
    completed["Completed (COMPLETED)"]
  end
  subgraph pay [payments: ledger]
    hold["Reserve coins, key hold:id (RESERVED)"]
    capture["Capture, key capture:id"]
    release["Release coins (RELEASED)"]
  end
  subgraph cas [Casino adapter]
    issue["Casino issues reward (ISSUED)"]
  end
  subgraph rec [Compensation and recovery]
    nofunds["Return stock (REJECTED_FUNDS)"]
    unknown["Ask casino by our key (UNKNOWN)"]
    review["Human review (NEEDS_REVIEW)"]
  end

  reserve --> hold --> request -->|issue with key| issue -->|ok| capture --> completed
  hold -->|insufficient coins, 409| nofunds
  issue -->|timeout| unknown
  unknown -->|refused: REJECTED| release
  unknown -->|maximum age| review
  unknown -->|lookup finds reward| issue
  issue -->|final refusal| release
  review -->|operator: issued| issue
  review -->|operator: rejected| release
```

## 4. ERD: the schema of the three databases

<a id="4-erd-tenancy-and-ledger"></a>

![4. ERD overview](img/erd.png)

Overview page: [`erd.html`](erd.html) (source [`erd.json`](erd.json)). It shows the tables that link the three
databases and the logical (dashed) links between them. The full schema is drawn once per database, from the TypeORM
migrations in `apps/*/src/model/migrations` (the final state after all of them) and checked against the live
databases with `\dt` and `\d` on a running stack:

| Database   | Tables | Business | Shared (outbox, inbox, audit_intents) | Interactive page                           | Typed source                               | PNG                                          |
| ---------- | ------ | -------- | ------------------------------------- | ------------------------------------------ | ------------------------------------------ | -------------------------------------------- |
| identity   | 13     | 10       | 3                                     | [erd-identity.html](erd-identity.html)     | [erd-identity.json](erd-identity.json)     | [erd-identity.png](img/erd-identity.png)     |
| engagement | 15     | 12       | 3                                     | [erd-engagement.html](erd-engagement.html) | [erd-engagement.json](erd-engagement.json) | [erd-engagement.png](img/erd-engagement.png) |
| payments   | 22     | 19       | 3                                     | [erd-payments.html](erd-payments.html)     | [erd-payments.json](erd-payments.json)     | [erd-payments.png](img/erd-payments.png)     |

That is 50 tables, 41 of them business tables (the TypeORM `migrations` bookkeeping table is not counted).
`outbox` and `inbox` (the bus tables) and `audit_intents` are created in every database by `packages/bus` and
`packages/service-kit`. Every table has `tenant_id` except `tenants` (its `id` is the tenant), `signing_keys` and `billing_plans` (both global).

Tenant scope and RLS (the policy is `tenant_id = current_setting('app.tenant_id')`, with `WITH CHECK`):

- ENABLE + FORCE RLS: every table with `tenant_id` except the ones below. That is 9 of the 13 identity tables
  (`users`, `user_roles`, `provider_links`, `player_links`, `launch_jti`, `integration_credentials`, `audit_log`,
  `reward_apis`, `audit_intents`), all 12 business tables of engagement and its `audit_intents`, and 18 of the 22
  payments tables.
- ENABLE without FORCE: `tenants` (identity), scoped on its own `id`.
- No RLS: `outbox` and `inbox` in all three databases (the relay and the dedupe work across tenants),
  `signing_keys` (identity), `billing_plans` and `reconciliation_tenants` (payments).

Tables that carry `sandbox` (the environment is part of the key, so production and sandbox never meet): `launch_jti`
(identity); `inbound_events`, `spin_credits`, `item_player_usage` and `redemptions` (engagement); `wallets`,
`accounts` and `wallet_owner_links` (payments). `integration_credentials` and `reward_apis` name the environment in an
`environment` text column (`production` or `sandbox`) instead.

Cross-service relations are logical, never foreign keys, and are drawn dashed or annotated: `tenant_id` in every
database points at identity `tenants`; `wallet_owner_links.user_id` (payments), `spin_credits.user_id` and
`redemptions.player_id` (engagement) hold an identity `users.id`; engagement `tenant_projections` is an event-fed copy
of `tenants`. Declared foreign keys exist only inside a database (identity: 7 tables to `tenants` and `users`;
engagement: `spins` to `spin_credits`; payments: the ledger and billing tables). Links such as `redemptions.item_id`
are logical inside engagement too and are drawn dashed.

### Identity (13 tables)

![4a. Identity ERD](img/erd-identity.png)

Interactive page: [`erd-identity.html`](erd-identity.html), opened locally. Mermaid copy:

```mermaid
erDiagram
  users }o--|| tenants : "belongs to"
  user_roles }o--|| users : "has"
  provider_links }o--|| users : "maps to"
  player_links }o--|| users : "maps to"
  launch_jti }o--|| tenants : "of"
  integration_credentials }o--|| tenants : "of"
  audit_log }o--|| tenants : "of"

  tenants["tenants (RLS, not forced)"] {
    uuid id PK
    text name
    text slug UK
    text type
    text status
  }
  users["users (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    text email
    text kind
  }
  user_roles["user_roles (RLS)"] {
    uuid tenant_id PK, FK
    uuid user_id PK, FK
    text role PK
  }
  provider_links["provider_links (RLS)"] {
    uuid tenant_id PK, FK
    uuid user_id PK, FK
    text provider UK
    text provider_uid UK
  }
  player_links["player_links (RLS)"] {
    uuid tenant_id PK, FK
    uuid user_id PK, FK
    text platform UK
    text external_player_id UK
  }
  launch_jti["launch_jti (RLS)"] {
    uuid tenant_id PK, FK
    boolean sandbox PK
    text jti PK
    timestamptz expires_at
  }
  integration_credentials["integration_credentials (RLS)"] {
    uuid tenant_id PK, FK
    text key_id PK
    text api_key_hash UK
    text environment
    text status
  }
  audit_log["audit_log (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    timestamptz occurred_at
    text action
  }
  reward_apis["reward_apis (RLS)"] {
    uuid tenant_id PK
    text platform PK
    text environment PK
    text base_url
  }
  signing_keys {
    text kid PK
    jsonb public_jwk
    boolean retired
  }
  outbox {
    uuid event_id PK
    uuid tenant_id
    text type
    timestamptz published_at
    timestamptz parked_at
  }
  inbox {
    text consumer PK
    uuid event_id PK
    uuid tenant_id
  }
  audit_intents["audit_intents (RLS)"] {
    uuid tenant_id PK
    uuid event_id PK
    jsonb envelope
  }
```

### Engagement (15 tables)

![4b. Engagement ERD](img/erd-engagement.png)

Interactive page: [`erd-engagement.html`](erd-engagement.html), opened locally. Mermaid copy:

```mermaid
erDiagram
  spins }o--|| spin_credits : "consumes"
  redemptions }o..|| store_items : "item_id (no FK)"
  item_player_usage }o..|| store_items : "item_id (no FK)"
  redemption_history }o..|| redemptions : "redemption_id (no FK)"
  redemption_work_queue }o..|| redemptions : "redemption_id (no FK)"

  tenant_projections["tenant_projections (RLS)"] {
    uuid tenant_id PK
    text name
    text slug
    integer applied_count
  }
  inbound_events["inbound_events (RLS)"] {
    uuid tenant_id PK
    boolean sandbox PK
    uuid id PK
    text source UK
    text external_event_id UK
    bigint amount_minor
  }
  rules["rules (RLS)"] {
    uuid tenant_id UK
    text rule_id UK
    integer version UK
    jsonb definition
  }
  reward_tables["reward_tables (RLS)"] {
    uuid tenant_id UK
    uuid wheel_id UK
    integer version UK
    jsonb definition
  }
  spin_credits["spin_credits (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    uuid user_id
    boolean sandbox
    uuid source_event_id UK
    text rule_id UK
    integer seq UK
    text status
  }
  spins["spins (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    uuid credit_id FK
    uuid user_id UK
    text operation_id UK
    integer reward_coins
  }
  store_items["store_items (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    integer version
    integer price
    integer stock
    boolean active
  }
  item_player_usage["item_player_usage (RLS)"] {
    uuid tenant_id PK
    uuid item_id PK
    text player_id PK
    boolean sandbox PK
    integer used
  }
  redemptions["redemptions (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    text player_id UK
    boolean sandbox UK
    text operation_key UK
    uuid item_id
    integer price
    text state
    text reservation
  }
  redemption_history["redemption_history (RLS)"] {
    uuid tenant_id PK
    bigint id PK
    uuid redemption_id
    text from_state
    text to_state
  }
  redemption_work_queue["redemption_work_queue (RLS)"] {
    uuid tenant_id PK
    uuid redemption_id PK
    timestamptz next_attempt_at
  }
  redemption_inbox["redemption_inbox (RLS)"] {
    uuid tenant_id PK
    text consumer PK
    text event_id PK
  }
  outbox {
    uuid event_id PK
    uuid tenant_id
    text type
    timestamptz published_at
    timestamptz parked_at
  }
  inbox {
    text consumer PK
    uuid event_id PK
    uuid tenant_id
  }
  audit_intents["audit_intents (RLS)"] {
    uuid tenant_id PK
    uuid event_id PK
    jsonb envelope
  }
```

### Payments (22 tables)

![4c. Payments ERD](img/erd-payments.png)

Interactive page: [`erd-payments.html`](erd-payments.html), opened locally. Mermaid copy:

```mermaid
erDiagram
  wallet_owner_links }o--|| wallets : "owner of"
  accounts }o--|| wallets : "player accounts"
  balances }o--|| accounts : "one row per"
  reserves }o--|| wallets : "holds coins of"
  ledger_entries }o--|| journal_transactions : "two or more"
  ledger_entries }o--|| accounts : "moves"
  subscriptions }o--|| billing_plans : "on plan"
  invoices }o--|| subscriptions : "bills"
  payment_attempts }o--|| subscriptions : "for"
  payment_attempts }o--|| billing_plans : "for plan"

  wallets["wallets (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    boolean sandbox
  }
  wallet_owner_links["wallet_owner_links (RLS)"] {
    uuid tenant_id PK, FK
    uuid wallet_id PK, FK
    uuid user_id UK
    boolean sandbox UK
  }
  accounts["accounts (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    uuid wallet_id FK
    text kind
    text currency
    boolean sandbox
  }
  balances["balances (RLS)"] {
    uuid tenant_id PK, FK
    uuid account_id PK, FK
    bigint amount
  }
  reserves["reserves (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    uuid wallet_id FK
    bigint amount
    text state
  }
  journal_transactions["journal_transactions (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    text operation_type UK
    uuid operation_id UK
    text currency
  }
  ledger_entries["ledger_entries (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    uuid transaction_id FK
    uuid account_id FK
    text direction
    bigint amount
  }
  idempotency_keys["idempotency_keys (RLS)"] {
    uuid tenant_id PK
    text principal_id PK
    text operation PK
    text key PK
    integer response_status
  }
  usage_events["usage_events (RLS)"] {
    uuid tenant_id PK
    uuid spin_id PK
    uuid event_id
    timestamptz counted_at
  }
  usage_meters["usage_meters (RLS)"] {
    uuid tenant_id PK
    text period PK
    text metric PK
    bigint quantity
  }
  usage_players["usage_players (RLS)"] {
    uuid tenant_id PK
    text period PK
    text player_key PK
  }
  usage_reports["usage_reports (RLS)"] {
    uuid tenant_id PK
    text period PK
    bigint quantity
    text idempotency_key
  }
  billing_plans {
    uuid id PK
    text code UK
    text name
    integer price_minor
    text currency
  }
  subscriptions["subscriptions (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    uuid plan_id FK
    text status
    text provider UK
    text provider_subscription_id UK
  }
  invoices["invoices (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    uuid subscription_id FK
    integer amount_minor
    text status
  }
  payment_attempts["payment_attempts (RLS)"] {
    uuid tenant_id PK, FK
    uuid id PK
    uuid plan_id FK
    uuid subscription_id FK
    text state
  }
  billing_webhook_events["billing_webhook_events (RLS)"] {
    uuid tenant_id PK
    text provider PK
    text event_id PK
  }
  reconciliation_runs["reconciliation_runs (RLS)"] {
    uuid tenant_id PK
    uuid id PK
    text status
    integer accounts_checked
  }
  reconciliation_tenants {
    uuid tenant_id PK
  }
  outbox {
    uuid event_id PK
    uuid tenant_id
    text type
    timestamptz published_at
    timestamptz parked_at
  }
  inbox {
    text consumer PK
    uuid event_id PK
    uuid tenant_id
  }
  audit_intents["audit_intents (RLS)"] {
    uuid tenant_id PK
    uuid event_id PK
    jsonb envelope
  }
```

Balances sit in `balances` (one row per account, `amount >= 0`); the ledger is `journal_transactions` with its
`ledger_entries` (a deferred trigger checks that debits equal credits, and a repeat is stopped by the unique
`(tenant_id, operation_type, operation_id)`). Operation types are `spin_award`, `reserve`, `capture`, `release` and
`refund`.

## 5. Lifecycle: redemption states

![5. Lifecycle: redemption states](img/lifecycle.png)

Interactive page: [`lifecycle.html`](lifecycle.html), opened locally. Mermaid copy:

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> RESERVED: coins reserved
  REQUESTED --> REJECTED_FUNDS: insufficient coins
  REQUESTED --> NEEDS_REVIEW: reserve refused for another reason
  RESERVED --> ISSUING: issue requested (committed first)
  ISSUING --> ISSUED: casino ok
  ISSUING --> UNKNOWN: timeout or lost reply
  ISSUING --> REJECTED: final refusal
  UNKNOWN --> ISSUED: lookup finds reward
  UNKNOWN --> ISSUING: not found, retry same key
  UNKNOWN --> REJECTED: lookup says rejected
  UNKNOWN --> NEEDS_REVIEW: maximum age or attempts
  REJECTED --> RELEASED: coins released
  REJECTED --> NEEDS_REVIEW: release refused
  ISSUED --> COMPLETED: capture
  ISSUED --> NEEDS_REVIEW: capture refused
  RELEASED --> NEEDS_REVIEW: late report
  COMPLETED --> REFUNDED: casino revoked
  COMPLETED --> NEEDS_REVIEW: refund refused or conflicting report
  NEEDS_REVIEW --> ISSUED: operator, lookup says issued
  NEEDS_REVIEW --> REJECTED: operator, lookup says rejected
  NEEDS_REVIEW --> UNKNOWN: replay, only if entered from UNKNOWN
  REJECTED_FUNDS --> [*]
  REFUNDED --> [*]
```
