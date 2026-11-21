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

| Priority | Meaning | Examples |
|---|---|---|
| P0 | Directly makes money, or blocks something that does | Operator self-serve onboarding and paid plan; the sellable demo scenario (the 8-step flow for both casinos from a clean clone); the analytics funnels; the coin ledger and redemption the demo depends on; tenancy, without which a second operator cannot be sold |
| P1 | Protects money or trust, or is a required assignment deliverable | Part C reliability tests, known-defect suites, architecture document, ADRs, README, samples, 90-day plan, audit log |
| P2 | Improves speed or quality; needed, but later | archify diagrams, rate limits, deploy manifest, alerts, visual regression |
| P3 | Can be done later | Prompt layering, prompt evals, prompt self-improvement, prompt security check, experiments |

Inside one priority, order by `money_impact` (`direct` before `enabler` before `none`), then by dependencies.

## Task fields

Each task file `tasks/MIO-NNN-<slug>.md` starts with YAML frontmatter:

| Field | Values | Meaning |
|---|---|---|
| `id` | `MIO-NNN` | Stable id; never reused |
| `title` | text | What will be true when the task is done |
| `epic` | `EPIC-NN` | Parent epic |
| `priority` | `P0`–`P3` | See the scale above |
| `money_impact` | `direct`, `enabler`, `none` | `direct`: changes revenue or what we can sell; `enabler`: something `direct` needs; `none`: neither |
| `risk_class` | `guard`, `identity`, `admission`, `budget`, `locks`, `concurrency`, `ownership`, `isolation`, `none` | The kind of defect that would hurt most. Any class other than `none` means the task goes through spec and failing tests first, and the reviewer re-applies a mutation for each guard |
| `status` | see below | Current state |
| `depends_on` | list of task ids | Tasks in this backlog that must be done first |
| `blocked_by` | list of strings (optional) | Prerequisites outside this backlog. `starter: <capability>` means a capability that the monorepo starter must gain first; other entries name a missing decision or material |
| `size` | `S`, `M`, `L` | Rough size: S up to a day, M a few days, L a week or more |

The body has: **Goal**, **Scope**, **Acceptance criteria** (testable), and **Notes** (sources, caveats).

A task with a `starter:` entry in `blocked_by` stays `todo`: its spec and failing tests can be written now,
but code waits for the starter capability. A task whose blocker is a decision or missing material is `blocked`.

### Risk classes

| Class | The defect it guards against |
|---|---|
| `guard` | A check that can be bypassed (signature, validation, permission) |
| `identity` | Wrong or forged identity, sessions, tokens |
| `admission` | Accepting the same or an invalid input twice or at all |
| `budget` | Money or limits going wrong: negative balance, double credit, limit overrun |
| `locks` | Duplicate effects from retried or parallel requests on one resource |
| `concurrency` | Races, lost updates, crash-in-the-middle, redelivery |
| `ownership` | Acting on an object that belongs to someone else |
| `isolation` | Data crossing tenant boundaries |

## Status values

| Status | Meaning |
|---|---|
| `todo` | Ready to be picked up (possibly waiting on a `starter:` capability for the code part) |
| `in-progress` | Someone is working on it |
| `review` | Waiting for or in independent review |
| `done` | Acceptance criteria verified, merged, documentation updated |
| `blocked` | Cannot move until the `blocked_by` reason is resolved |
| `needs-owner-review` | The owner reviews the task before work starts |

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

## Epics

| Epic | Title | Priority | Tasks | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|---|---|
| [EPIC-01](epics/EPIC-01-foundations-local-dev.md) | Foundations and local development | P0 | 9 | 5 | 4 | 0 | 0 |
| [EPIC-02](epics/EPIC-02-architecture-decisions.md) | Architecture and decisions (Part A) | P1 | 8 | 1 | 7 | 0 | 0 |
| [EPIC-03](epics/EPIC-03-archify-diagrams.md) | Diagrams as code with archify (needs owner review) | P2 | 8 | 0 | 0 | 8 | 0 |
| [EPIC-04](epics/EPIC-04-tenancy.md) | Tenancy | P0 | 5 | 3 | 2 | 0 | 0 |
| [EPIC-05](epics/EPIC-05-identity.md) | Identity | P0 | 7 | 4 | 2 | 1 | 0 |
| [EPIC-06](epics/EPIC-06-integrations.md) | Casino integrations module and event ingestion | P0 | 8 | 6 | 2 | 0 | 0 |
| [EPIC-07](epics/EPIC-07-engagement.md) | Engagement: rules, wheel, bonus store, redemption | P0 | 11 | 8 | 2 | 1 | 0 |
| [EPIC-08](epics/EPIC-08-ledger-payments.md) | Coin ledger in the payments service | P0 | 6 | 4 | 2 | 0 | 0 |
| [EPIC-09](epics/EPIC-09-monetization.md) | Monetization: operator billing, plans, metering, entitlements | P0 | 10 | 8 | 2 | 0 | 0 |
| [EPIC-10](epics/EPIC-10-analytics.md) | Product analytics through Varta | P0 | 9 | 4 | 4 | 0 | 1 |
| [EPIC-11](epics/EPIC-11-realtime.md) | Realtime websocket | P0 | 4 | 2 | 1 | 1 | 0 |
| [EPIC-12](epics/EPIC-12-design.md) | Design and design system | P0 | 6 | 1 | 4 | 1 | 0 |
| [EPIC-13](epics/EPIC-13-web.md) | Web: player widget, operator console, platform admin console | P0 | 5 | 3 | 2 | 0 | 0 |
| [EPIC-14](epics/EPIC-14-reliability-security.md) | Reliability and security test suite (Part C) | P1 | 14 | 0 | 13 | 1 | 0 |
| [EPIC-15](epics/EPIC-15-observability-audit-deploy.md) | Observability, audit, security baseline, deploy | P1 | 6 | 0 | 3 | 3 | 0 |
| [EPIC-16](epics/EPIC-16-ai-native-development.md) | AI-native development and AI-readiness (Part D) | P1 | 10 | 0 | 4 | 1 | 5 |
| [EPIC-17](epics/EPIC-17-submission-docs.md) | Submission documents and scaling plan (Deliverables, Part E) | P1 | 7 | 0 | 5 | 2 | 0 |
| **Total** | | | **133** | **49** | **59** | **19** | **6** |

## Waiting on someone

| Task | Status | Reason |
|---|---|---|
| MIO-020 to MIO-027 (archify) | `needs-owner-review` | The owner reviews the archify tasks before work starts |
| MIO-184 Screenshots of Deckhand and Varta | `needs-owner-review` | The owner reviews every screenshot before publishing |
| MIO-041 Identity provider choice | `blocked` | The team has not decided yet; local Firebase Auth Emulator meanwhile |
| MIO-120 Brand and visual style | `blocked` | Owner has no brand or style materials yet |
| MIO-106 Analytics panel | `todo` | Waits on Varta: product events stream and generated analytics dashboard |

Tasks waiting on a monorepo starter capability (`blocked_by: starter: …`): MIO-001, MIO-002, MIO-006,
MIO-007, MIO-015, MIO-030, MIO-032, MIO-040, MIO-056, MIO-066, MIO-080, MIO-101, MIO-110, MIO-111,
MIO-123, MIO-146, MIO-163.

## Coverage of the assignment

Every item of the assignment maps to at least one task.

### Part A: System architecture

| Assignment item | Tasks |
|---|---|
| Multi-tenant SaaS with tenant isolation | MIO-030, MIO-031, MIO-032, MIO-033, MIO-034, MIO-146 |
| Casino integration layer supporting different external APIs | MIO-050, MIO-051, MIO-052, MIO-057 |
| Player identity mapping | MIO-044, MIO-042 |
| Event ingestion, validation, deduplication and processing | MIO-054, MIO-055, MIO-056, MIO-015 |
| Gamification rules engine | MIO-060, MIO-061 |
| Virtual currency ledger | MIO-081, MIO-082, MIO-083, MIO-084, MIO-085 |
| Reward redemption and delivery | MIO-065, MIO-066, MIO-067, MIO-068 |
| Admin configuration | MIO-060, MIO-062, MIO-065, MIO-131, MIO-132 |
| Observability, auditability and security | MIO-160, MIO-161, MIO-162, MIO-164, MIO-165, MIO-016, MIO-045, MIO-046 |
| Architecture diagram | MIO-011 (and MIO-021 to MIO-027 once approved) |
| Short explanation of major technical decisions | MIO-010, MIO-013, MIO-014, MIO-017 |
| Which components are modules and which are services | MIO-012 |

### Part B: Working prototype

| Assignment item | Tasks |
|---|---|
| 1. Casino Platform A sends a successful deposit event | MIO-051 |
| 2. MIO Games validates and processes the event | MIO-054, MIO-055, MIO-056 |
| 3. The player receives one Wheel of Fortune spin | MIO-060, MIO-061 |
| 4. Player spins; deterministic, server-authoritative reward from a weighted table | MIO-062, MIO-063 |
| 5. Coin reward recorded in the virtual currency ledger | MIO-064, MIO-081, MIO-082 |
| 6. Player redeems coins for a reward from the Bonus Store | MIO-065, MIO-066 |
| 7. Reward issuance requested through the casino integration adapter | MIO-066, MIO-050 |
| 8. Reward final status tracked and exposed through an API | MIO-067 |
| Two simulated casino platforms with different event schemas and reward API formats | MIO-051, MIO-052, MIO-053 |
| Both use the same internal gamification logic | MIO-050, MIO-052, MIO-057 |
| The whole workflow runnable end to end | MIO-005, MIO-003 |

### Part C: Reliability and security

| Assignment item | Tasks |
|---|---|
| Duplicate deposit events | MIO-140 (mechanism MIO-055, MIO-056, MIO-061) |
| Concurrent spin requests | MIO-141 (mechanism MIO-063) |
| Duplicate redemption requests | MIO-142 (mechanism MIO-066) |
| External API timeouts | MIO-143 (mechanism MIO-068) |
| Failed reward issuance | MIO-144 (mechanism MIO-066) |
| Retries and eventual recovery | MIO-145 (mechanism MIO-056, MIO-068) |
| Tenant isolation | MIO-146, MIO-149 (mechanism MIO-032, MIO-033) |
| Invalid or unauthorized events | MIO-147 (mechanism MIO-054) |
| No duplicate rewards or negative coin balances | MIO-148, MIO-150, MIO-081, MIO-082 |
| Preventing manipulation of reward probabilities and unauthorized spins (explanation) | MIO-069, MIO-151 |
| Demonstration of all cases | MIO-153, MIO-005 (`--faults`) |

### Part D: AI-native development

| Assignment item | Tasks |
|---|---|
| AI used to plan implementation | MIO-172, MIO-173 |
| AI used to generate or modify code | MIO-172, MIO-173 |
| AI used to create tests | MIO-172, MIO-173 |
| AI used to review implementation | MIO-172, MIO-173 |
| AI used to identify and fix defects | MIO-173, MIO-149, MIO-150 |
| Representative agent instructions | MIO-170, MIO-174, MIO-175 |
| Workflow configurations | MIO-174, MIO-006 |
| Evidence of AI-generated changes | MIO-173 |
| Which decisions you made yourself, and how you verified AI output | MIO-172, MIO-173 |

### Part E: Scaling the product

| Assignment item | Tasks |
|---|---|
| 1. Evolve the prototype into a production-ready multi-tenant SaaS | MIO-182 |
| 2. Support 10 casino operators without 10 codebases | MIO-182, MIO-057, MIO-050 |
| 3. PvP, Missions, Kingdom Builder without coupling to the integration layer | MIO-182, MIO-070 |
| 4. First 90 days | MIO-183 |
| 5. Smallest realistic team for an MVP in six months | MIO-182 |
| 6. Parts of the development process to automate with AI | MIO-182 |

### Deliverables and general notes

| Assignment item | Tasks |
|---|---|
| Git repository with working code | MIO-001, MIO-005, MIO-003 |
| README with setup instructions and assumptions | MIO-180 |
| Architecture diagram | MIO-011 |
| Automated tests | MIO-006, MIO-140 to MIO-151 |
| Sample requests and responses | MIO-181 |
| Short AI-development evidence log | MIO-173 |
| First 90-day engineering plan | MIO-183 |
| Docker Compose for reproducible local execution | MIO-002, MIO-003 |
| Explain technology choices | MIO-017 |
| Document unfinished items and priorities | MIO-186 |
| Live change request after submission | MIO-185 |

## Beyond the assignment

| Area | Epic |
|---|---|
| Operator billing, plans, usage metering, entitlements, Stripe behind `PaymentProvider` | EPIC-09 |
| Product analytics through Varta (event taxonomy is a one-way door) | EPIC-10 |
| Design prototype, brand, Storybook design system | EPIC-12 |
| Mandatory, resilient websocket | EPIC-11 |
| Player widget, operator console, platform admin console | EPIC-13 |
| AI-readiness: `AGENTS.md`, `memory/`, docs index, `CONTRACTS.md`, `prompts/` | EPIC-16 |
| Diagrams as code with archify | EPIC-03 |
