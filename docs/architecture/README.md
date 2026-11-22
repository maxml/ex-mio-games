# Architecture diagrams

Five diagrams, each kept as a typed archify IR file (`*.json`), a rendered interactive page (`*.html`), and a Mermaid copy below that renders inline on any git host. The prose is in [overview.md](overview.md); decisions are in [`docs/adrs/`](../adrs/).

| Diagram                                      | Interactive page                       | Typed source                           |
| -------------------------------------------- | -------------------------------------- | -------------------------------------- |
| Context and containers                       | [architecture.html](architecture.html) | [architecture.json](architecture.json) |
| Sequence: the 8-step workflow                | [sequence.html](sequence.html)         | [sequence.json](sequence.json)         |
| Workflow: redemption saga with compensations | [workflow.html](workflow.html)         | [workflow.json](workflow.json)         |
| ERD: tenancy and ledger                      | [erd.html](erd.html)                   | [erd.json](erd.json)                   |
| Lifecycle: redemption states                 | [lifecycle.html](lifecycle.html)       | [lifecycle.json](lifecycle.json)       |

The HTML pages are standalone files; open them locally in a browser (a git host shows their source, not the page).

## Why each diagram exists

Each diagram answers one question. The table links the question to the Part A items of the task, the decisions
behind it and the reliability cases it shows. To go from a document to a picture, follow the "Diagram:" line at
the top of every ADR, of the overview and of the specs. Each picture below is a PNG render; the interactive
page is the `*.html` file next to it (see [View it locally](#view-it-locally)).

| Diagram                                                                     | Question it answers                                                     | Part A items                                                                                                            | ADRs                                                                                                                                                                                                                                                                                                                                                                       | Specs                                                                                                                                                                    | Part C                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [Context and containers](#1-context-and-containers)                         | What are the parts and who talks to whom?                               | tenant isolation, integration layer, identity mapping, ledger, admin configuration (web console), observability (Varta) | [0001](../adrs/0001-microservices-and-their-cost.md), [0002](../adrs/0002-tenancy-model.md), [0003](../adrs/0003-rabbitmq-outbox-inbox.md), [0007](../adrs/0007-identity-interface-and-emulator.md), [0008](../adrs/0008-integration-adapters-canonical-model.md), [0009](../adrs/0009-analytics-via-varta.md), [0011](../adrs/0011-container-per-service-and-deckhand.md) | all five                                                                                                                                                                 | C-7 tenant isolation                                       |
| [Sequence: the 8-step workflow](#2-sequence-the-8-step-workflow)            | What happens, in order, from deposit to a tracked reward?               | ingestion, validation and deduplication, identity mapping, ledger, redemption and delivery                              | [0003](../adrs/0003-rabbitmq-outbox-inbox.md), [0004](../adrs/0004-virtual-currency-ledger.md), [0005](../adrs/0005-rng-and-fairness.md), [0006](../adrs/0006-redemption-saga.md), [0008](../adrs/0008-integration-adapters-canonical-model.md)                                                                                                                            | [engagement-ingest](../specs/engagement-ingest.md), [identity](../specs/identity.md), [payments](../specs/payments.md), [engagement-store](../specs/engagement-store.md) | C-1 duplicate deposit, C-2 concurrent spins                |
| [Workflow: redemption saga](#3-workflow-redemption-saga-with-compensations) | Which steps and compensations does a redemption run, and who owns each? | redemption and delivery                                                                                                 | [0006](../adrs/0006-redemption-saga.md), [0004](../adrs/0004-virtual-currency-ledger.md), [0008](../adrs/0008-integration-adapters-canonical-model.md)                                                                                                                                                                                                                     | [engagement-store](../specs/engagement-store.md), [payments](../specs/payments.md)                                                                                       | C-3 duplicate redemption, C-4 timeout, C-8 failed issuance |
| [ERD: tenancy and ledger](#4-erd-tenancy-and-ledger)                        | Which tables carry the tenant, and how do ledger entries balance?       | tenant isolation, ledger, identity mapping                                                                              | [0002](../adrs/0002-tenancy-model.md), [0004](../adrs/0004-virtual-currency-ledger.md), [0007](../adrs/0007-identity-interface-and-emulator.md)                                                                                                                                                                                                                            | [identity](../specs/identity.md), [payments](../specs/payments.md)                                                                                                       | C-6b no negative balance, C-7 tenant isolation             |
| [Lifecycle: redemption states](#5-lifecycle-redemption-states)              | Which states can a redemption be in, and which moves are allowed?       | redemption and delivery                                                                                                 | [0006](../adrs/0006-redemption-saga.md)                                                                                                                                                                                                                                                                                                                                    | [engagement-store](../specs/engagement-store.md)                                                                                                                         | C-4 timeout and recovery, C-8 failed issuance              |

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
`erd.png` and `lifecycle.png`.

## Tooling and version

- Archify is a git submodule at `tools/archify`, pinned to tag `v3.2.0` (commit `208acba8d412335185b2056fedf54b3405df43fb`), Apache-2.0.
- `tools/archify-render.sh` validates and re-renders all five diagrams. `tools/archify-render.sh --check` validates only, for CI. Needs Node 18 or newer and `git submodule update --init tools/archify`.
- The Mermaid copies are written by hand and must agree with the IR files. When one changes, change the other (ADR 0012).
- Built, partial and next items are marked in [overview.md](overview.md#14-built-versus-designed). The Stripe adapter, websocket replay, the production identity provider, rate limiting and per-service deployment secrets are next, not built.
- The Mermaid copies and the IR files agree with the code. The `*.html` pages were re-rendered from the corrected IR with the pinned archify renderer (state names `RESERVED`, `REJECTED`, `RELEASED`; payments credits coins from `spin.completed`; the realtime gateway `/rt` in engagement; Redis as an optional balance projection).

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
    idb[(Postgres identity)]
    edb[(Postgres engagement)]
    pdb[(Postgres payments)]
  end

  web -->|login, launch| identity
  web -->|REST, websocket /rt| engagement
  engagement -->|sync coin reserve| payments
  identity --> idb
  engagement --> edb
  payments --> pdb
  identity -.-> rabbit
  engagement -.-> rabbit
  rabbit -.-> payments
  payments -.-> redis

  varta[[Varta: observability and analytics]]
  deckhand[[Deckhand: blue-green deploy]]
  platform -.->|logs, events on stdout| varta
  deckhand -.->|deploys containers| platform
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
  E-->>C: 202, a duplicate gets the same answer
  E-->>U: one spin available, websocket (step 3)
  U->>E: POST /spins with Idempotency-Key (step 4)
  E-->>U: reward from the weighted table
  E-)P: spin.completed event via outbox (step 5)
  P->>P: credit coins, key spin:spin_id (inbox, once)
  U->>E: POST /redemptions (step 6)
  E->>P: reserve coins, key hold:redemption_id (sync)
  P-->>E: reserved, or 409 insufficient_funds
  E->>C: issue reward with our key (step 7)
  C-->>E: ok, or timeout then lookup by our key
  E->>P: capture hold
  P-->>E: captured
  U->>E: GET /redemptions/:id (step 8)
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
  review -->|operator, on evidence| completed
```

## 4. ERD: tenancy and ledger

![4. ERD: tenancy and ledger](img/erd.png)

Interactive page: [`erd.html`](erd.html), opened locally. Mermaid copy:

```mermaid
erDiagram
  tenants ||--o{ users : "belongs to"
  users ||--o{ player_links : "maps to"
  users ||--o{ user_roles : has
  accounts ||--o{ ledger_entries : moves
  journal_transactions ||--|{ ledger_entries : "2 or more entries"
  wallets ||--o{ accounts : owns
  wallets ||--o{ reserves : reserves

  tenants {
    uuid id PK
    text name
    text slug UK
    text type
    text status
  }
  users {
    uuid tenant_id PK
    uuid id PK
    text email
    text kind
  }
  user_roles {
    uuid tenant_id PK
    uuid user_id PK
    text role
  }
  player_links {
    uuid tenant_id PK
    text platform PK
    text external_player_id PK
    uuid user_id FK
  }
  wallets {
    uuid tenant_id PK
    uuid id PK
    boolean sandbox
  }
  accounts {
    uuid tenant_id PK
    uuid id PK
    uuid wallet_id FK
    text kind
    text currency
  }
  journal_transactions {
    uuid tenant_id PK
    uuid id PK
    text operation_type UK
    uuid operation_id UK
    timestamptz created_at
  }
  ledger_entries {
    uuid tenant_id PK
    uuid id PK
    uuid transaction_id FK
    uuid account_id FK
    text direction
    bigint amount
  }
  reserves {
    uuid tenant_id PK
    uuid id PK
    uuid wallet_id FK
    bigint amount
    text state
  }
```

Identity tables live in the identity database and ledger tables in the payments database. There is no foreign key between the two; `payments` stores opaque ids (`wallets` links to a player through `wallet_owner_links`, which erasure deletes). Balances sit in a `balances` table (one row per account, `amount >= 0`).

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
  COMPLETED --> REFUNDED: casino revoked
  NEEDS_REVIEW --> ISSUED: operator, lookup says issued
  NEEDS_REVIEW --> REJECTED: operator, lookup says rejected
  NEEDS_REVIEW --> UNKNOWN: replay, only if entered from UNKNOWN
  REJECTED_FUNDS --> [*]
  RELEASED --> [*]
  COMPLETED --> [*]
  REFUNDED --> [*]
```
