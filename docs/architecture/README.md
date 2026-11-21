# Architecture diagrams

Five diagrams, each kept as a typed archify IR file (`*.json`), a rendered interactive page (`*.html`), and a Mermaid copy below that renders inline on any git host. The prose is in [overview.md](overview.md); decisions are in [`docs/adrs/`](../adrs/).

| Diagram | Interactive page | Typed source |
|---|---|---|
| Context and containers | [architecture.html](architecture.html) | [architecture.json](architecture.json) |
| Sequence: the 8-step workflow | [sequence.html](sequence.html) | [sequence.json](sequence.json) |
| Workflow: redemption saga with compensations | [workflow.html](workflow.html) | [workflow.json](workflow.json) |
| ERD: tenancy and ledger | [erd.html](erd.html) | [erd.json](erd.json) |
| Lifecycle: redemption states | [lifecycle.html](lifecycle.html) | [lifecycle.json](lifecycle.json) |

The HTML pages are standalone files; open them locally in a browser (a git host shows their source, not the page).

## Tooling and version

- Archify is a git submodule at `tools/archify`, pinned to tag `v3.2.0` (commit `208acba8d412335185b2056fedf54b3405df43fb`), Apache-2.0.
- `tools/archify-render.sh` validates and re-renders all five diagrams. `tools/archify-render.sh --check` validates only, for CI. Needs Node 18 or newer and `git submodule update --init tools/archify`.
- The Mermaid copies are written by hand and must agree with the IR files. When one changes, change the other (ADR 0012).
- Built versus designed items are marked in [overview.md](overview.md#14-built-versus-designed). The Stripe adapter, websocket replay, the production identity provider and per-service deployment secrets are designed only.

## 1. Context and containers

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
    redis[(Redis: cache, rate limits, ws journal)]
    idb[(Postgres identity)]
    edb[(Postgres engagement)]
    pdb[(Postgres payments)]
  end

  web -->|login, launch| identity
  web -->|REST, websocket| engagement
  identity --> idb
  engagement --> edb
  payments --> pdb
  identity -.-> rabbit
  engagement -.-> rabbit
  rabbit -.-> payments
  rabbit -.->|ws fan-out| redis

  varta[[Varta: observability and analytics]]
  deckhand[[Deckhand: blue-green deploy]]
  platform -.->|logs, events on stdout| varta
  deckhand -.->|deploys containers| platform
```

## 2. Sequence: the 8-step workflow

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
  E->>P: credit coins, operation id = spin id (step 5)
  U->>E: POST /redemptions (step 6)
  E->>P: hold coins, hold id = redemption id
  P-->>E: held
  E->>C: issue reward with our key (step 7)
  C-->>E: ok, or timeout then lookup by our key
  E->>P: capture hold
  P-->>E: captured
  U->>E: GET /redemptions/:id (step 8)
  E-->>U: ISSUED, then COMPLETED
```

## 3. Workflow: redemption saga with compensations

```mermaid
flowchart LR
  subgraph eng [engagement: saga owner]
    reserve["Reserve stock and limit (REQUESTED)"]
    request["Request issuance (ISSUING)"]
    completed["Completed (COMPLETED)"]
  end
  subgraph pay [payments: ledger]
    hold["Hold coins, key hold:id (HELD)"]
    capture["Capture hold, key capture:id"]
    release["Release hold (FAILED)"]
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
  hold -->|insufficient coins| nofunds
  issue -->|timeout| unknown
  unknown -->|refused| release
  unknown -->|maximum age| review
```

## 4. ERD: tenancy and ledger

```mermaid
erDiagram
  tenant ||--o{ app_user : "belongs to"
  app_user ||--o{ player_link : "maps to"
  ledger_account ||--o{ journal_leg : moves
  journal_transaction ||--|{ journal_leg : "2 or more legs"
  ledger_account ||--o{ coin_hold : reserves

  tenant {
    uuid id PK
    text kind
    text domain UK
    text status
  }
  app_user {
    uuid tenant_id PK
    uuid user_id PK
    text email
    text role
  }
  player_link {
    uuid tenant_id PK
    text platform PK
    text external_player_id PK
    uuid user_id FK
  }
  ledger_account {
    uuid tenant_id PK
    uuid id PK
    uuid owner_user_id
    text kind
    bigint balance_minor
  }
  journal_transaction {
    uuid tenant_id PK
    uuid id PK
    text operation_type UK
    text operation_id UK
    timestamptz created_at
  }
  journal_leg {
    uuid tenant_id PK
    uuid id PK
    uuid transaction_id FK
    uuid account_id FK
    text direction
    bigint amount_minor
  }
  coin_hold {
    uuid tenant_id PK
    uuid id PK
    uuid account_id FK
    bigint amount_minor
    text status
  }
```

Identity tables live in the identity database and ledger tables in the payments database. There is no foreign key between the two; `payments` stores opaque ids.

## 5. Lifecycle: redemption states

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> HELD: hold placed
  REQUESTED --> REJECTED_FUNDS: insufficient coins
  HELD --> ISSUING: issue requested
  ISSUING --> ISSUED: casino ok
  ISSUING --> UNKNOWN: timeout or lost reply
  ISSUING --> FAILED: final refusal
  UNKNOWN --> ISSUED: lookup finds reward
  UNKNOWN --> NEEDS_REVIEW: maximum age
  ISSUED --> COMPLETED: capture
  COMPLETED --> REFUNDED: casino revoked
  REJECTED_FUNDS --> [*]
  FAILED --> [*]
  NEEDS_REVIEW --> [*]
  COMPLETED --> [*]
  REFUNDED --> [*]
```
