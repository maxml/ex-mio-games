# ex-mio-games backlog

This is the product backlog for the MIO Games vertical slice: epics in `epics/`, tasks in `tasks/`.
It covers every item of the assignment (Parts A to E and the Deliverables) and goes beyond them where
the product needs it to make money: operator billing, analytics, design.

## Principles

1. **First prove it can make money.** Everything we do serves that. Priority equals profit impact.
2. **In architecture, think only about what is very expensive to change later.** Do everything else the
   simplest way; we will sort it out later.
3. **Product analytics from day one, through Varta.** Without data we cannot decide anything. Profit
   still comes first.
4. **Design drives money.** The whole frontend is built from Storybook components.

## Priority scale

| Priority | Meaning                                                                  | Examples                                                                                                                                            |
| -------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | The first sellable slice (below) and exactly what it needs, nothing else | Operator self-serve signup and paid plan; one connected casino; deposit, spin, coins, store, issued reward; the funnels; the guards those APIs need |
| P1       | Protects money or trust, or is a required assignment deliverable         | Part C reliability tests, known-defect suites, architecture document, ADRs, README, samples, 90-day plan, audit log                                 |
| P2       | Improves speed or quality; needed, but later                             | archify diagrams, rate limits, deploy manifest, alerts, visual regression                                                                           |
| P3       | Can be done later                                                        | Prompt layering, prompt evals, prompt self-improvement, prompt security check, experiments                                                          |

Inside one priority, order by `money_impact` (`direct` before `enabler` before `none`), then by dependencies.
A task never depends on a task of lower priority (checked mechanically).

## First sellable slice

The smallest thing a casino operator can find, try and pay for, end to end:

operator self-serve signup → casino simulator connected → deposit → spin → coins → store → reward
issued → plan paid (`fake` provider) → funnel visible in analytics.

Its executable definition is MIO-005 (`pnpm demo`), run from a fresh clone with no accounts. **P0 is
exactly MIO-005, the design prototype MIO-121 (the owner's pre-code gate), and everything they depend on,
directly or transitively.** Everything else is P1 or lower, including work the owner requires but the
slice does not: Casino B, fault injection and recovery demos, metering, entitlements, the live websocket,
the full operator console, the clean-clone CI job and the Part C suites.

|                                                      | Before (b6fc551)                                                                          | After                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tasks labelled P0                                    | 49                                                                                        | 49                                                                                                                                                                                   |
| Tasks a P0 task actually needed (transitive closure) | 54 (five P1 tasks were hidden prerequisites: MIO-033, MIO-046, MIO-098, MIO-122, MIO-123) | 49 (the label and the closure are the same set)                                                                                                                                      |
| Moved out of P0                                      |                                                                                           | MIO-003, MIO-004, MIO-052, MIO-095, MIO-096, MIO-097, MIO-110, MIO-112, MIO-131                                                                                                      |
| Moved into P0                                        |                                                                                           | MIO-045, MIO-046, MIO-122, MIO-123 (prerequisites that were hidden or missing), MIO-013, MIO-057, MIO-134, MIO-135, MIO-086 (contracts and decisions that must come before the code) |

The count did not fall, because the old 49 understated what the slice needed by five and the reviews
added five contract and decision tasks that must precede the code. What changed is that P0 is now
complete: nothing outside it is needed to sell the slice.

## Task fields

Each task file `tasks/MIO-NNN-<slug>.md` starts with YAML frontmatter:

| Field                 | Values                                                                                               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `MIO-NNN`                                                                                            | Stable id; never reused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `title`               | text                                                                                                 | What will be true when the task is done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `epic`                | `EPIC-NN`                                                                                            | Parent epic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `priority`            | `P0`–`P3`                                                                                            | See the scale above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `money_impact`        | `direct`, `enabler`, `none`                                                                          | `direct`: changes revenue or what we can sell; `enabler`: something `direct` needs; `none`: neither                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `risk_class`          | `guard`, `identity`, `admission`, `budget`, `locks`, `concurrency`, `ownership`, `isolation`, `none` | The kind of defect that would hurt most. Any class other than `none` means the task goes through spec and failing tests first, and the reviewer re-applies a mutation for each guard                                                                                                                                                                                                                                                                                                                                                                           |
| `status`              | see below                                                                                            | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `depends_on`          | list of task ids                                                                                     | Tasks in this backlog that must be done first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blocked_by`          | list of strings (optional)                                                                           | Prerequisites outside this backlog. `starter: <capability>` means a capability that the monorepo starter must gain first; other entries name a missing decision or material                                                                                                                                                                                                                                                                                                                                                                                    |
| `size`                | `S`, `M`, `L`                                                                                        | Rough size band of the base estimate: S up to 8 hours, M 12 to 24 hours, L 32 to 48 hours                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `estimate_hours_base` | integer                                                                                              | Focused engineering hours for one experienced engineer to finish the task to its acceptance criteria: code, tests, review fixes and documentation. Meetings are not included. For a task with a `risk_class` other than `none` it includes the specification, the failing tests and the hostile review (the process in `docs/ai`). It is a judgement from the task's Scope and Acceptance criteria, not a function of `size`; the size band is a sanity check, and a task outside its band gets a one-line "Estimate:" note under Notes, or a different `size` |
| `estimate_hours`      | integer                                                                                              | `ceil(estimate_hours_base * 1.2)`: the base plus the 20% buffer. This is the number people plan with                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The body has: **Goal**, **Scope**, **Acceptance criteria** (testable), and **Notes** (sources, caveats).

A task with a `starter:` entry in `blocked_by` stays `todo`: its spec and failing tests can be written now,
but code waits for the starter capability. A task whose blocker is a decision or missing material is `blocked`.

### Risk classes

| Class         | The defect it guards against                                                |
| ------------- | --------------------------------------------------------------------------- |
| `guard`       | A check that can be bypassed (signature, validation, permission)            |
| `identity`    | Wrong or forged identity, sessions, tokens                                  |
| `admission`   | Accepting the same or an invalid input twice or at all                      |
| `budget`      | Money or limits going wrong: negative balance, double credit, limit overrun |
| `locks`       | Duplicate effects from retried or parallel requests on one resource         |
| `concurrency` | Races, lost updates, crash-in-the-middle, redelivery                        |
| `ownership`   | Acting on an object that belongs to someone else                            |
| `isolation`   | Data crossing tenant boundaries                                             |

## Estimates and totals

**Buffer rule (owner decision):** every task carries a 20% buffer. `estimate_hours` is always
`ceil(estimate_hours_base * 1.2)`; the size bands apply to the base value. The buffer is per task, so the
totals below are sums of the per-task values, not 1.2 times the base total.

Planning conversion used in `docs/scaling/README.md` (Part E): 6 productive hours per engineer per day and
21 working days per month. Hours are one experienced engineer's focused time, with no AI speed-up assumed.

| Scope                                          | Tasks   | Base hours | Hours with 20% buffer |
| ---------------------------------------------- | ------- | ---------- | --------------------- |
| EPIC-01 Foundations and local development      | 10      | 102        | 129                   |
| EPIC-02 Architecture and decisions             | 8       | 89         | 110                   |
| EPIC-03 Diagrams as code with archify          | 8       | 64         | 81                    |
| EPIC-04 Tenancy                                | 5       | 88         | 107                   |
| EPIC-05 Identity                               | 8       | 160        | 195                   |
| EPIC-06 Casino integrations                    | 9       | 136        | 166                   |
| EPIC-07 Engagement                             | 14      | 202        | 248                   |
| EPIC-08 Coin ledger                            | 8       | 121        | 148                   |
| EPIC-09 Monetization                           | 10      | 180        | 219                   |
| EPIC-10 Product analytics                      | 10      | 96         | 120                   |
| EPIC-11 Realtime websocket                     | 4       | 70         | 85                    |
| EPIC-12 Design and design system               | 6       | 126        | 154                   |
| EPIC-13 Web                                    | 8       | 212        | 256                   |
| EPIC-14 Reliability and security tests         | 16      | 254        | 310                   |
| EPIC-15 Observability, audit, deploy           | 7       | 82         | 101                   |
| EPIC-16 AI-native development                  | 10      | 104        | 131                   |
| EPIC-17 Submission documents                   | 13      | 91         | 116                   |
| EPIC-18 Performance, capacity and load testing | 5       | 80         | 99                    |
| P0 (the first sellable slice)                  | 49      | 988        | 1,200                 |
| P1                                             | 80      | 982        | 1,214                 |
| P2                                             | 24      | 217        | 274                   |
| P3                                             | 6       | 70         | 87                    |
| **Grand total**                                | **159** | **2,257**  | **2,775**             |

The P0 row is the first sellable slice: MIO-005, MIO-121 and everything they depend on. With the buffer it
is 1,200 hours, 200 person-days, 9.5 person-months. P0 and P1 together are 2,414 hours.

Reproduce every figure above with this read-only command, run from the repository root (the epic and
priority rows come from the same pass; P0 is the `P0` row):

```sh
awk 'FNR==1{fm=0} /^---$/{fm++; if(fm==2){N[e]++;B[e]+=b;H[e]+=h;PN[p]++;PB[p]+=b;PH[p]+=h;T++;TB+=b;TH+=h} next} fm==1{if($1=="epic:")e=$2;if($1=="priority:")p=$2;if($1=="estimate_hours_base:")b=$2;if($1=="estimate_hours:")h=$2} END{for(k in N)printf "epic %s %d %d %d\n",k,N[k],B[k],H[k];for(k in PN)printf "prio %s %d %d %d\n",k,PN[k],PB[k],PH[k];printf "total %d %d %d\n",T,TB,TH}' backlog/tasks/*.md | sort
```

Each output row is `kind name tasks base_hours buffered_hours`. A second read-only check confirms the buffer
rule on every task (it prints nothing when all 159 tasks agree):

```sh
awk '/^estimate_hours_base:/{b=$2} /^estimate_hours:/{if($2!=int((b*12+9)/10))print FILENAME}' backlog/tasks/*.md
```

## Status values

| Status               | Meaning                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `todo`               | Ready to be picked up (possibly waiting on a `starter:` capability for the code part) |
| `in-progress`        | Someone is working on it                                                              |
| `review`             | Waiting for or in independent review                                                  |
| `done`               | Acceptance criteria verified, merged, documentation updated                           |
| `blocked`            | Cannot move until the `blocked_by` reason is resolved                                 |
| `needs-owner-review` | The owner reviews the task before work starts                                         |

## How a task flows

1. **Brief.** The coordinator picks the highest-priority unblocked task, records its risk class, and
   writes a short brief. The coordinator does not write product code.
2. **Spec.** A spec author turns the task into a specification with testable acceptance criteria.
3. **Failing tests first.** A test author writes tests from the spec, without the implementation. The
   tests must fail before any code exists.
4. **Code.** A coder makes the tests pass without changing them.
5. **Independent review.** A reviewer on a stronger model, in a fresh session, gets the code and the
   requirements, not the author's conclusions. The reviewer uses the running product, writes regression
   tests at the choke point (where a bad value cannot be constructed) before any fix, re-applies one
   mutation per claimed guard or fix and watches that test go red, adds a reader test for every new
   durable record, and re-runs the author's numbers.
6. **Fix and re-review.** Each re-review starts with the question "what did this fix move?", not "is it fixed?".
7. **Merge.** After review and green tests, with documentation updated in the same merge. Status becomes `done`.

## Graph rules

The dependency graph must agree with "tests before code". Three kinds of task, in this order:

1. **Contract and decision tasks** (no product code): MIO-013 data decisions, MIO-015 contracts,
   MIO-050 adapter interface, MIO-057 adapter contract suite, MIO-086 idempotency contract, MIO-100
   event taxonomy, MIO-135 embedding decision, the ADR tasks. They come first.
2. **Implementation tasks** depend on the contracts they implement. Each one writes its own failing
   tests before its code, including every row of the known-defect suites (MIO-149, MIO-150) that names
   it as the mechanism.
3. **Integration and acceptance checks** (the Part C suites MIO-140 to MIO-154, MIO-005, MIO-003,
   MIO-153) depend on the implementations they check. An implementation task never depends on a check.

`depends_on` is the only ordering. A task's acceptance criteria may not require a task that depends on
it (that is a hidden cycle); forward pointers go under **Notes**. A mechanical check, run before each
backlog change is merged, verifies: every referenced id exists, no dependency cycle, no hidden acceptance cycle, no
priority inversion, and P0 equals the closure of MIO-005 and MIO-121.

## Start conditions for every task that exposes an API or consumes messages

These hold for every such task in addition to its `depends_on`, so no API can start without its guards:

- **Starter contract** (from the monorepo starter, which the product consumes): tenancy package (request
  tenant context, RLS helpers, isolation test kit), identity guard (JWT verification against JWKS with a
  fixed algorithm and per-service audience; default-deny routes), event bus with outbox, inbox and DLQ,
  idempotency package for value operations, analytics emitter, structured logger with redaction.
- **Product guards:** MIO-032 (isolation enforcement) and MIO-045 (permissions) are done before any
  operator or player route is written; MIO-046 before any service-to-service route; MIO-086 before any
  value operation; MIO-013 before any schema that stores money, personal data or audit records.
- **UI:** the design prototype (MIO-121) and the Storybook design system (MIO-123) before any screen.

The tasks that need these list them in `depends_on` as well where the dependency is a backlog task.

## Gates

- **Publication:** nothing is pushed to a public remote before MIO-192 (pre-publication privacy gate)
  is done; every later push passes it.
- **Embedding:** no identity or web task that handles a player session starts before MIO-135.
- **Data decisions:** no ledger, saga, identity or analytics schema is written before MIO-013.

May start now, before any starter capability lands: the design prototype with a placeholder theme
(MIO-121), design tokens (MIO-122), contract and decision tasks (MIO-013, MIO-015, MIO-050, MIO-057,
MIO-086, MIO-100, MIO-135), state diagrams for money, and the failing tests of any task whose contract
is accepted. P3 prompt work stays deferred.

## Status codes shared by every task

- Idempotency (MIO-086): `409 idempotency_in_progress` while the first call runs; `422
idempotency_key_reused` for the same key with a different request; the stored response otherwise.
- Domain conflicts (insufficient funds, spin credit already used, out of stock) are `409` with their own
  error code; validation errors are `422`; a foreign object is `404`.

## Epics

| Epic                                                   | Title                                                                       | Priority | Tasks   | P0     | P1     | P2     | P3    |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | -------- | ------- | ------ | ------ | ------ | ----- |
| [EPIC-01](epics/EPIC-01-foundations-local-dev.md)      | Foundations and local development                                           | P0       | 10      | 3      | 7      | 0      | 0     |
| [EPIC-02](epics/EPIC-02-architecture-decisions.md)     | Architecture and decisions (Part A)                                         | P1       | 8       | 2      | 6      | 0      | 0     |
| [EPIC-03](epics/EPIC-03-archify-diagrams.md)           | Diagrams as code with archify (needs owner review)                          | P2       | 8       | 0      | 0      | 8      | 0     |
| [EPIC-04](epics/EPIC-04-tenancy.md)                    | Tenancy                                                                     | P0       | 5       | 3      | 2      | 0      | 0     |
| [EPIC-05](epics/EPIC-05-identity.md)                   | Identity                                                                    | P0       | 8       | 6      | 0      | 2      | 0     |
| [EPIC-06](epics/EPIC-06-integrations.md)               | Casino integrations module and event ingestion                              | P0       | 9       | 6      | 3      | 0      | 0     |
| [EPIC-07](epics/EPIC-07-engagement.md)                 | Engagement: rules, wheel, bonus store, redemption                           | P0       | 14      | 8      | 4      | 2      | 0     |
| [EPIC-08](epics/EPIC-08-ledger-payments.md)            | Coin ledger in the payments service                                         | P0       | 8       | 5      | 3      | 0      | 0     |
| [EPIC-09](epics/EPIC-09-monetization.md)               | Monetization: operator billing, plans, metering, entitlements               | P0       | 10      | 5      | 5      | 0      | 0     |
| [EPIC-10](epics/EPIC-10-analytics.md)                  | Product analytics through Varta                                             | P0       | 10      | 4      | 4      | 1      | 1     |
| [EPIC-11](epics/EPIC-11-realtime.md)                   | Realtime websocket                                                          | P1       | 4       | 0      | 3      | 1      | 0     |
| [EPIC-12](epics/EPIC-12-design.md)                     | Design and design system                                                    | P0       | 6       | 3      | 2      | 1      | 0     |
| [EPIC-13](epics/EPIC-13-web.md)                        | Web: player widget, operator console, platform admin console                | P0       | 8       | 4      | 3      | 1      | 0     |
| [EPIC-14](epics/EPIC-14-reliability-security.md)       | Reliability and security test suite (Part C)                                | P1       | 16      | 0      | 15     | 1      | 0     |
| [EPIC-15](epics/EPIC-15-observability-audit-deploy.md) | Observability, audit, security baseline, deploy                             | P1       | 7       | 0      | 4      | 3      | 0     |
| [EPIC-16](epics/EPIC-16-ai-native-development.md)      | AI-native development and AI-readiness (Part D)                             | P1       | 10      | 0      | 4      | 1      | 5     |
| [EPIC-17](epics/EPIC-17-submission-docs.md)            | Submission documents, scaling plan, publication gate (Deliverables, Part E) | P1       | 13      | 0      | 11     | 2      | 0     |
| [EPIC-18](epics/EPIC-18-performance-capacity.md)       | Performance, capacity and load testing                                      | P1       | 5       | 0      | 4      | 1      | 0     |
| **Total**                                              |                                                                             |          | **159** | **49** | **80** | **24** | **6** |

## Waiting on someone

| Task                                      | Status               | Reason                                                                                    |
| ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| MIO-020 to MIO-027 (archify)              | `needs-owner-review` | The owner reviews the archify tasks before work starts                                    |
| MIO-184 Screenshots of Deckhand and Varta | `needs-owner-review` | The owner reviews every screenshot before publishing                                      |
| MIO-041 Identity provider choice          | `blocked`            | The team has not decided yet; local Firebase Auth Emulator meanwhile                      |
| MIO-120 Brand and visual style            | `blocked`            | Owner has no brand or style materials yet                                                 |
| MIO-106 Analytics panel                   | `todo`               | Waits on Varta: product events stream and generated analytics dashboard                   |
| MIO-192 Pre-publication privacy gate      | `todo`               | Needs the maintainer's private denylist and inspection tool, kept outside this repository |

Tasks waiting on a monorepo starter capability (`blocked_by: starter: …`): MIO-001, MIO-002, MIO-006,
MIO-007, MIO-015, MIO-030, MIO-032, MIO-040, MIO-056, MIO-066, MIO-080, MIO-086, MIO-096, MIO-101,
MIO-110, MIO-111, MIO-112, MIO-123, MIO-146, MIO-152, MIO-161, MIO-163.

## Coverage of the assignment

Every item of the assignment maps to at least one task.

### Part A: System architecture

| Assignment item                                             | Tasks                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Multi-tenant SaaS with tenant isolation                     | MIO-030, MIO-031, MIO-032, MIO-033, MIO-034, MIO-146, MIO-154          |
| Casino integration layer supporting different external APIs | MIO-050, MIO-051, MIO-052, MIO-057                                     |
| Player identity mapping                                     | MIO-044, MIO-042, MIO-135                                              |
| Event ingestion, validation, deduplication and processing   | MIO-054, MIO-055, MIO-056, MIO-015                                     |
| Gamification rules engine                                   | MIO-060, MIO-061                                                       |
| Virtual currency ledger                                     | MIO-081, MIO-082, MIO-083, MIO-084, MIO-085, MIO-086                   |
| Reward redemption and delivery                              | MIO-065, MIO-066, MIO-067, MIO-068, MIO-086                            |
| Admin configuration                                         | MIO-060, MIO-062, MIO-065, MIO-131, MIO-132                            |
| Observability, auditability and security                    | MIO-160, MIO-161, MIO-162, MIO-164, MIO-165, MIO-016, MIO-045, MIO-046 |
| Architecture diagram                                        | MIO-011 (and MIO-021 to MIO-027 once approved)                         |
| Short explanation of major technical decisions              | MIO-010, MIO-013, MIO-014, MIO-017                                     |
| Which components are modules and which are services         | MIO-012                                                                |

### Part B: Working prototype

| Assignment item                                                                    | Tasks                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1. Casino Platform A sends a successful deposit event                              | MIO-051                                                                                   |
| 2. MIO Games validates and processes the event                                     | MIO-054, MIO-055, MIO-056                                                                 |
| 3. The player receives one Wheel of Fortune spin                                   | MIO-060, MIO-061                                                                          |
| 4. Player spins; deterministic, server-authoritative reward from a weighted table  | MIO-062, MIO-063                                                                          |
| 5. Coin reward recorded in the virtual currency ledger                             | MIO-064, MIO-081, MIO-082                                                                 |
| 6. Player redeems coins for a reward from the Bonus Store                          | MIO-065, MIO-066                                                                          |
| 7. Reward issuance requested through the casino integration adapter                | MIO-066, MIO-050                                                                          |
| 8. Reward final status tracked and exposed through an API                          | MIO-067                                                                                   |
| Two simulated casino platforms with different event schemas and reward API formats | MIO-051, MIO-052, MIO-053                                                                 |
| Both use the same internal gamification logic                                      | MIO-050, MIO-052, MIO-057                                                                 |
| The whole workflow runnable end to end                                             | MIO-005 (Casino A), MIO-052 (Casino B, identical assertions), MIO-003 (clean clone in CI) |

### Part C: Reliability and security

| Assignment item                                                                      | Tasks                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Duplicate deposit events                                                             | MIO-140 (mechanism MIO-055, MIO-056, MIO-061)                              |
| Concurrent spin requests                                                             | MIO-141 (mechanism MIO-063)                                                |
| Duplicate redemption requests                                                        | MIO-142 (mechanism MIO-066, MIO-086)                                       |
| External API timeouts                                                                | MIO-143 (mechanism MIO-068, MIO-050 recovery contract)                     |
| Failed reward issuance                                                               | MIO-144 (mechanism MIO-066)                                                |
| Retries and eventual recovery                                                        | MIO-145 (mechanism MIO-056, MIO-068)                                       |
| Tenant isolation                                                                     | MIO-146, MIO-149, MIO-154 (mechanism MIO-032, MIO-033, MIO-044)            |
| Invalid or unauthorized events                                                       | MIO-147 (mechanism MIO-054)                                                |
| No duplicate rewards or negative coin balances                                       | MIO-148, MIO-150, MIO-081, MIO-082, MIO-084 (conservation report)          |
| Preventing manipulation of reward probabilities and unauthorized spins (explanation) | MIO-069, MIO-151, MIO-154                                                  |
| Demonstration of all cases                                                           | MIO-153, MIO-145 (`pnpm demo --faults`, with an ambiguous external result) |

### Part D: AI-native development

| Assignment item                                                   | Tasks                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| AI used to plan implementation                                    | MIO-172, MIO-173                                                          |
| AI used to generate or modify code                                | MIO-172, MIO-173                                                          |
| AI used to create tests                                           | MIO-172, MIO-173                                                          |
| AI used to review implementation                                  | MIO-172, MIO-173                                                          |
| AI used to identify and fix defects                               | MIO-173 (one traced defect, AI change and verification), MIO-149, MIO-150 |
| Representative agent instructions                                 | MIO-170, MIO-174, MIO-175 (sanitized through MIO-192)                     |
| Workflow configurations                                           | MIO-174, MIO-006                                                          |
| Evidence of AI-generated changes                                  | MIO-173                                                                   |
| Which decisions you made yourself, and how you verified AI output | MIO-172 (human decisions versus AI table), MIO-173                        |

### Part E: Scaling the product

| Assignment item                                                             | Tasks                                                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1. Evolve the prototype into a production-ready multi-tenant SaaS           | MIO-187 (with the production roadmap), assembled in MIO-182; scale-out numbers from MIO-193, MIO-194 and MIO-196 |
| 2. Support 10 casino operators without 10 codebases                         | MIO-188 (evidence MIO-057, MIO-052, MIO-092)                                                                     |
| 3. PvP, Missions, Kingdom Builder without coupling to the integration layer | MIO-189 (with MIO-070)                                                                                           |
| 4. First 90 days                                                            | MIO-183                                                                                                          |
| 5. Smallest realistic team for an MVP in six months                         | MIO-190                                                                                                          |
| 6. Parts of the development process to automate with AI                     | MIO-191                                                                                                          |

### Deliverables and general notes

| Assignment item                                 | Tasks                       |
| ----------------------------------------------- | --------------------------- |
| Git repository with working code                | MIO-001, MIO-005, MIO-003   |
| README with setup instructions and assumptions  | MIO-180                     |
| Architecture diagram                            | MIO-011                     |
| Automated tests                                 | MIO-006, MIO-140 to MIO-154 |
| Sample requests and responses                   | MIO-181                     |
| Short AI-development evidence log               | MIO-173                     |
| First 90-day engineering plan                   | MIO-183                     |
| Docker Compose for reproducible local execution | MIO-002, MIO-003            |
| Explain technology choices                      | MIO-017                     |
| Document unfinished items and priorities        | MIO-186                     |
| Live change request after submission            | MIO-185                     |

## Beyond the assignment

| Area                                                                                                      | Epic              |
| --------------------------------------------------------------------------------------------------------- | ----------------- |
| Operator billing, plans, usage metering, entitlements, Stripe behind `PaymentProvider`                    | EPIC-09           |
| Product analytics through Varta (event taxonomy is a one-way door)                                        | EPIC-10           |
| Design prototype, brand, Storybook design system                                                          | EPIC-12           |
| Mandatory, resilient websocket                                                                            | EPIC-11           |
| Player widget, operator console, platform admin console                                                   | EPIC-13           |
| AI-readiness: `AGENTS.md`, `memory/`, docs index, `CONTRACTS.md`, `prompts/`                              | EPIC-16           |
| Publication privacy gate (the repository is public)                                                       | EPIC-17 (MIO-192) |
| Production roadmap: onboarding and suspension, credential rotation, retention, restore, failure ownership | EPIC-17 (MIO-187) |
| Diagrams as code with archify                                                                             | EPIC-03           |
| Performance: SLOs, load tests, CI gate, capacity model, soak                                              | EPIC-18           |
