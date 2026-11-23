# Part E: scaling the product

Short technical plan for the six questions of Part E. The 90-day plan by phase is in [90-days.md](90-days.md).

Status words: **Built** means implemented in the submission, **Partial** means the core exists and the named part does not, **Designed** (or "Next") means decided and described but not implemented. The status of each system item follows the table in [`docs/architecture/overview.md`](../architecture/overview.md) section 14. Anything in the plan below that is not in that table is a plan, not a fact. Team size, durations and speed-ups are estimates, not measurements, unless a sentence says it was measured.

Working principles (from the product owner, they decide every trade-off below):

1. Prove it can make money first. Priority equals profit impact.
2. In architecture, think only about what is very expensive to change later. Do the rest the simplest way.
3. Product analytics from day one, through Varta.
4. Design drives money: the frontend is built from Storybook components.

## 1. From prototype to production-ready multi-tenant SaaS

Answer: in five phases, ordered by risk to money and trust, with the first paying operator reached at the end of phase 2 and not after phase 5. Each phase has a pass/fail exit, so it is clear when to stop.

What the prototype already has, so the phases do not redo it: three domain services (`identity`, `engagement`, `payments`) with a database each, plus `web` and `casino-sim`, RabbitMQ with outbox and inbox, Postgres RLS with tenant-isolation tests, a double-entry ledger, a redemption saga with an operator review route, two casino adapters behind one canonical model, an identity interface backed by the Firebase Auth Emulator, and a Socket.IO gateway in `engagement` with at-most-once delivery. These are Built per the overview. A `fake` payment provider is Built. Not built, and counted in the phases below: rate limiting, product events emitted by the services (the contract and logger function exist), console writes for rules and wheel versions, refresh tokens.

### Phase 0: close the known gaps that block any real money (before the pilot goes live)

| Item                          | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Production needs                                                                                                                                      | Exit                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Per-service secrets on deploy | Designed, not claimed. Services are isolated at the database level, but deploy delivers secrets without per-service scoping                                                                                                                                                                                                                                                                                                                                                                 | Each service gets only its own secrets from Deckhand's secret store; database owner and runtime roles use separate credentials; rotation procedure    | A deploy drill shows service A cannot read service B's secret; one rotation done with no downtime                                 |
| Identity provider choice      | The interface and the emulator are Built; the production provider is not chosen                                                                                                                                                                                                                                                                                                                                                                                                             | Choose and wire one production provider (criteria below), keep the emulator for tests                                                                 | Same adapter contract test passes against the real provider in a staging project                                                  |
| Stripe adapter                | `fake` is Built; Stripe is an interface only                                                                                                                                                                                                                                                                                                                                                                                                                                                | A `stripe` implementation of `PaymentProvider`, webhook signature check, idempotency key per charge                                                   | Sandbox charge, refund and a replayed webhook each produce exactly one ledger effect                                              |
| Reward API configuration      | Built in code (D-27): the operator registers each casino's reward API with `PUT /v1/operator/integrations/:casino/reward-api` and identity serves it as `reward_api`. Without it an order stops in `NEEDS_REVIEW` with `no_adapter`. Run end to end against casino-sim on a live stack by `scripts/demo.sh` on `1aa98e0` (registration in step 7, issuance to `ISSUED` and a rejection to `RELEASED` in steps 29, 30 and 40; root README); not yet against a real casino (known gaps, G-15) | Run one issuance through the registered API on the compose stack, then through the pilot casino's staging API; an operator-facing form in the console | An order placed by a stranger on a fresh tenant reaches `COMPLETED` without a database edit                                       |
| Rule and wheel publishing     | Built in code (D-27): `PUT /v1/operator/rules` and `PUT /v1/operator/wheel`, a default rule and wheel on signup. The web console still answers those calls from its mock (known gaps, G-4), and the sandbox-check and go-live routes do not exist                                                                                                                                                                                                                                           | Switch the console to the routes; add the sandbox-check and go-live routes; prove "signed deposit leads to one spin" in one compose test              | A fresh tenant gets a spin from a signed deposit with no SQL, and a published wheel version changes the next spin's table version |
| Open reviewer-found defects   | Two tenant and environment defects were red in the review run; their tests and fixes are in this tree, the re-run on the final tree is open (known gaps, S-11)                                                                                                                                                                                                                                                                                                                              | Merge the final integration branch with its invariant tests and re-run them                                                                           | `INV-ENV-SCHEMA` and `INV-AUD-MATRIX` green on the merged tree                                                                    |

Identity provider choice. Criteria, in order: per-tenant users with the same email in two tenants (a hard requirement of the tenancy ADR), cost per active user, data residency, lock-in. Default recommendation: keep the Firebase/Identity Platform adapter that the emulator already mirrors, because the multi-tenant model is the same and the switch costs the least. The alternative is a self-hosted OIDC server, chosen only if a customer demands residency that the managed provider cannot give. This is a recommendation to confirm, not a decision already taken.

### Phase 1: observability and SLOs

- Structured logs with correlation, tenant and trace ids go to Varta (structured stdout logs are Built, the product-event contract is Built and 12 product events are emitted to stdout by the services (`docs/analytics.md`), and Varta ingestion of them is live on pre-prod, with a dedicated stream and longer retention on the Varta side; see `docs/observability/varta.md`).
- Two user-journey SLOs to start: deposit to spin credit visible, and redemption request to final status. Initial targets are proposals: 99.5% of deposits credit a spin within 5 seconds, 99% of redemptions reach a final status within 2 minutes, zero double credits. Revisit after four weeks of real data. The latency and throughput budget of each critical path (p95 and p99, per tenant and in aggregate) is the SLO table of backlog task MIO-193, measured by the k6 load-test harness (MIO-194) and guarded by a smoke-load run on every main merge and a nightly full run (MIO-195). Performance has not been measured yet; see the gap row S-15 in [../submission/known-gaps.md](../submission/known-gaps.md).
- Alerts tied to the SLOs and to the invariants: ledger reconciliation mismatch, DLQ depth, redemptions in `UNKNOWN` or `NEEDS_REVIEW` past their deadline, inbound signature failures per tenant.
- Runbooks: DLQ replay, `NEEDS_REVIEW` redemption, casino unreachable, broker down. One named on-call role.
- Exit: an induced fault (broker stopped for 10 minutes) triggers the alert, and the runbook brings the system back with ledger reconciliation clean.

### Phase 2: backups, restore and data residency

- Point-in-time recovery for each service database. A backup that was never restored is not a backup: the exit is a restore drill with a measured recovery time and a ledger reconciliation run before traffic resumes.
- Target to start with: restore within 1 hour, at most 5 minutes of data loss. Both are proposals.
- Data residency. Personal data is already confined to `identity` (audit rows hold no personal data, so erasure never edits them). Decide the region per tenant at signup, store it on the tenant, and pin that tenant's identity data to that region. Start with one region and refuse tenants that need another, instead of building multi-region before a customer asks. Moving a large tenant to its own database, and per-tenant restore, are Designed only.
- Retention and erasure: the retention period per data class, the erasure path through the player mapping table, and log redaction at the logger.
- Exit: restore drill passed, retention table published, one erasure request executed end to end.

### Phase 3: first paying pilot hardening

- Real casino integration through an adapter, with the sandbox/production flag on the integration credential (Section 2).
- Billing live with Stripe on the operator plan, metering that excludes sandbox events.
- Rate limits per tenant, so one operator cannot starve another.
- Websocket journal replay. Live push is Built. Missed-event replay is not: the client resyncs over REST after a reconnect, and Socket.IO `connectionStateRecovery` stays off because in the version in use it restores rooms and missed packets before the auth middleware runs. The design: an authenticated journal with an epoch and a journal id kept in Redis (persistence on), replayed only after the one-time ticket has been verified. Build it when players complain about missed rewards, not before; REST resync is correct, only less smooth.
- Exit: one paid operator, one real casino, a month without a reconciliation mismatch.

### Phase 4: scale-out

Only when the numbers ask for it: read replicas, partitioning the ledger legs by tenant, moving the integrations module out of `engagement` into a service if adapter traffic needs separate scaling, a dedicated database for a very large tenant. Each is Designed and none is started before a measured bottleneck. The measurement and the trigger values come from the capacity model (backlog task MIO-196: tenants, players and events per second to database connections, RabbitMQ throughput and Postgres size, with a scale-out trigger table), calibrated by the load-test baseline and checked by an hours-long soak run (MIO-197).

### Migration rules that hold in every phase

- Schema changes expand first, contract later. No deploy needs downtime (Deckhand does blue-green).
- Feature flags per tenant for anything new.
- RNG certification and regulator-facing evidence are out of scope until a licensed operator requires them. Say so to the customer, do not hide it.

## 2. Ten operators without ten codebases

Answer: one codebase, one adapter per casino platform type (not per operator), and everything that differs between operators lives in tenant configuration. A new operator on a known platform is configuration only. A new platform is one adapter plus a passing contract suite.

### What is code and what is configuration

| Code (shared, one release for all)                                                                           | Tenant configuration (data, per operator)                                                     |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Canonical event and command types                                                                            | Integration credentials, webhook secrets, platform type, `environment: sandbox or production` |
| Adapter per platform type: signature scheme, event schema mapping, reward API call, native lookup by our key | Rules (versioned), wheel weight tables (versioned), Bonus Store catalog and stock             |
| Rules engine, wheel, redemption saga, ledger                                                                 | Rate limits, plan and entitlements, branding for the player widget                            |
| Identity interface, tenancy and RLS                                                                          | Region, retention settings                                                                    |

### The adapter registry

The casino port is defined once, in the shared contracts package. The registry resolves, for a tenant, the adapter and its configuration from that tenant's integration credentials. Rules, wheel, store and ledger see only canonical types and never a casino payload. Each adapter must declare one of two recovery properties: native lookup by our idempotency key, or guaranteed idempotent replay. Lost-reply recovery depends on it, so an adapter that has neither is not accepted.

Issue results are four-valued: `issued`, `pending`, `rejected`, `unknown`. A timeout is `unknown` and never a failure. A refund is allowed only after `rejected`, or after `not_found` on a lookup made after the issue deadline.

### Contract tests per adapter

One adapter contract suite, parameterised by adapter. It runs for every adapter in CI and checks: signature rejection and timestamp window, schema validation, deduplication of a repeated event, the four issue results, lookup by our key, behaviour on timeout, and that the canonical event carries only the internal player id. Adding an adapter means adding it to the suite's list. A failing row blocks the merge.

Built: two simulated casino platforms with different schemas, and the contract suite. Not Built: any real casino. The simulators prove the shape of the port, not the quirks of a real platform; expect the first real adapter to find gaps.

### Sandbox

The integration credential carries `environment: sandbox or production`. The engagement service derives the `sandbox` flag from the credential that authenticated the webhook or launch, never from a header or client input, and sets it on the event envelope. Payments keeps separate sandbox wallets. Metering excludes sandbox events, so a sandbox flag cannot remove a paid operation from the bill and a sandbox spin never credits a production wallet. An operator tests against the sandbox with the casino simulator before it touches production.

### Onboarding time per new casino

These are estimates for planning, to be replaced by measured values after the first two onboardings:

| Case                                        | Estimate                     | What it takes                                                                                                     |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| New operator, known platform                | under 1 day, self-serve      | Sign up, enter credentials, configure rules and catalog, pass sandbox checklist, switch environment               |
| New platform type                           | 1 to 2 weeks of one engineer | Read the casino's API, write the adapter, pass the contract suite, one staging run with the casino's test account |
| Operator-specific quirk on a known platform | do not allow                 | If two operators on one platform differ in behaviour, that is a configuration option on the adapter, not a fork   |

### What changes at ten operators

Per-tenant rate limits and fair queues so one operator's burst does not delay another; per-tenant dashboards in Varta; a support runbook per adapter. Nothing in the data model changes: tenancy is already `tenant_id` on every table with RLS.

## 3. PvP, Missions and Kingdom Builder without coupling to the casino layer

Answer: new features consume canonical domain events and ask `payments` for coins. They never import the integrations module, never call an adapter and never read a casino payload. This is enforced by module boundaries in the build, not by convention.

### Boundaries

| Boundary                                                   | Rule                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations` module (inside `engagement`)                | The only code that knows casino payloads. Publishes canonical events. Nothing imports it except the engagement composition root                                                                                                                                            |
| Canonical events                                           | The only input new features may use: `deposit.confirmed`, `spin.completed`, `coins.*` (credited, debited, refunded, held), redemption events                                                                                                                               |
| `payments` service                                         | The only writer of coins. A feature that rewards coins asks payments through the allow-listed internal route with an idempotency key; it cannot mint arbitrarily (the service-token allow-list limits `engagement` to reserve, capture, release, refund and balance reads) |
| Events carry the internal `player_id` and `tenant_id` only | A feature never learns the casino's external player id                                                                                                                                                                                                                     |

The check: Nx module boundary rules fail the build if a feature module imports `integrations`. A scan test proves that the rule fails when a forbidden import is added (a mutation of the guard).

### How a feature is switched on

Per tenant and per plan, through tenant configuration and entitlements. A feature that is off ignores the events for that tenant. Feature flags are per tenant, so a pilot operator can get Missions before the others.

### Missions

- Consumes: `deposit.confirmed`, `spin.completed`, `coins.credited`.
- Publishes: `mission.progressed`, `mission.completed`.
- Owns: mission definitions (per tenant, versioned) and per-player progress.
- Where: a module inside `engagement` first, next to the rules engine, because a mission is a rule with state over several events and shares its transaction and outbox. Promote to a service only when it needs its own scaling or release cadence.
- Reward: a coin reward goes through `payments` with key `mission:<id>:<player>`, so a redelivered event credits once.
- Needs from the integration layer: nothing new.

### PvP

- Consumes: `spin.completed` (to score), `coins.*` (stake and payout).
- Publishes: `pvp.match.created`, `pvp.match.settled`.
- Owns: matches, entries, results.
- Where: its own service. It holds money in flight (stakes), needs real-time matching with its own load profile, and a bug in it must not stop the casino loop. Stakes are held and settled through `payments` holds, the same mechanism as redemption.
- Fairness: results must be reproducible by an auditor, like the wheel (versioned server seed, outcome stored with its seed version). PvP involving real-money stakes may carry regulatory limits that vary by jurisdiction; check before building, and default to coins with no cash value.
- Needs from the integration layer: nothing, as long as stakes are in coins.

### Kingdom Builder

- Consumes: `coins.credited`, `spin.completed`, mission events.
- Publishes: `kingdom.building.completed`.
- Owns: a per-player game state (buildings, timers, resources).
- Where: its own service, because it is a long-lived state machine with its own storage and release cadence, and it is the most likely to be written by a different team.
- Coins: spending coins to build goes through `payments` debits with an idempotency key per action.
- Needs from the integration layer: nothing. If a casino-side reward (for example a free-spin grant after a building) is wanted, it is a canonical `reward.requested` command handled by `engagement`'s existing issue flow; the feature never calls the adapter.

### Cost of the boundary

An extra hop and eventual consistency: a feature sees a spin a moment after it happens, and a player sees the balance through the read projection. This is accepted. The ADR on microservices records that the split costs complexity, so a feature stays a module until one of the reasons above applies.

## 4. First 90 days

Answer: the slice already exists (P0 is implemented, demoed and deployed to a pre-production server), so weeks 1 and 2 take it to production, and then three phases of 30 days each. What sets the calendar is not code: a real casino partner's API access, sandbox and contract; real payments (a Stripe account, legal and tax); the first paying operators and their feedback on real data from the Varta analytics panel; security review and gambling-compliance requirements in the target markets; and hiring. The AI-assisted, reviewed process shortens the coding share, not these. The full plan with exit criteria is in [90-days.md](90-days.md).

### Weeks 1 and 2: take the existing slice to production

- Deliverables: the follow-ups MIO-198 to MIO-221 and the known gaps; real per-service secrets and separate database credentials; a production identity provider; monitoring and alerts on the SLO table with a load-test baseline; backups with a restore drill; the proven Deckhand deploy repeated on the production host.
- Exit criteria: production deploy drill passes; restore time measured; an induced broker outage alerts and recovers with a clean reconciliation.

### Days 15 to 30: first real casino integration

- Deliverables: an adapter on the canonical model, using the how-to, passing the contract suite on the casino's sandbox.
- Exit criteria: one test deposit gives one spin credit, once; zero double rewards on a replayed-webhook run; Stripe sandbox charge, refund and replay give one ledger effect each.

### Days 31 to 60: first paying operators

- Deliverables: pilot on the real casino, self-serve signup, billing live, per-tenant rate limits, the funnel in Varta, fixes from the pilot's findings.
- Exit criteria: at least one operator live and paying; real deposits processed, each credited once; redemption success rate at or above 99% within 2 minutes; p95 latency inside the EPIC-18 SLOs; zero double rewards; two weeks with no reconciliation mismatch.

### Days 61 to 90: second operators and the new mechanics

- Deliverables: a second operator by configuration only; Missions enabled for one tenant; PvP (coins only) and Kingdom Builder in staging; retrospective of review findings per change and escaped defects.
- Exit criteria: at least two paying tenants; no code change in the shared repository for the second; Missions live for a paying tenant; zero double rewards in PvP and Kingdom Builder staging runs.

Deliberately not done in 90 days: real-money PvP, multi-region, RNG certification, moving existing modules to services, websocket journal replay unless players report missed rewards.

## 5. Smallest realistic team for an MVP in six months

Answer: three engineers and a part-time product owner, about 3.5 FTE. Everything in this section is an estimate with its reasoning shown; none of it is a measurement from this project.

| Role                                                                             | FTE | Why                                                                                                     |
| -------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------- |
| Founding engineer (backend, payments and identity, owns architecture and review) | 1.0 | The expensive-to-change parts are money and tenancy. One person must hold them and review the rest      |
| Backend engineer (integrations, engagement, new features)                        | 1.0 | Adapters, rules, saga, Missions. Two backend people allow review by a second pair of eyes               |
| Frontend engineer with design skill                                              | 1.0 | Design drives money; the whole frontend is built from Storybook components, widget and operator console |
| Product owner (also talks to operators)                                          | 0.5 | Chooses what earns money, runs the pilot, handles contracts                                             |

Not in the core team and bought or borrowed: SRE (about 0.2 FTE, a contractor for the first two months to set up backups, alerts and the restore drill; after that the founding engineer carries on-call), QA (replaced by test-first process, Section 6).

The hours in this section are the estimated effort for a human team to take the product to production. They are not the time the prototype took.

Reasoning for the number: the MVP scope is the first sellable slice (P0, 49 tasks) plus production hardening (P1, 83 tasks); P2 and P3 (34 tasks) come later. Source of the effort figure: the backlog in this repository. Every task file carries `estimate_hours`, the estimated effort of one experienced engineer to reach the acceptance criteria (code, tests, review fixes, docs; no meetings). The totals below are the sums of that field and are reproduced by the command in `backlog/README.md`. Assumptions of this plan: 6 productive hours per engineer per day and 21 working days per month.

| Scope                     | Tasks | Estimated effort (hours) | Person-days at 6 h | Person-months at 21 days |
| ------------------------- | ----- | ------------------------ | ------------------ | ------------------------ |
| First sellable slice (P0) | 49    | 1,200                    | 200                | 9.5                      |
| MVP scope (P0 and P1)     | 132   | 2,449                    | 408                | 19.4                     |
| Whole backlog             | 168   | 2,838                    | 473                | 22.5                     |

The previous version of this plan counted sizes only (S = 1 day, M = 2 to 3 days, L = 5 days) and got 241 to 300 person-days (11.5 to 14.3 person-months) for the 142 original tasks. The same 142 tasks are now 2,515 hours, 419 person-days, because each task is estimated from its own scope and acceptance criteria, and the backlog has grown by the five performance tasks (MIO-193 to MIO-197, 99 hours) and by nineteen follow-up tasks from the review rounds (MIO-198 to MIO-218, 214 hours). The hour values are judgments per task, not measurements, and they assume no AI speed-up.

Capacity at 3.5 FTE over 6 months (126 working days) is 3.5 x 126 x 6 = 2,646 hours, 21 person-months. The 6 productive hours a day replace the earlier flat 15% deduction for meetings and support: they leave 2 of 8 hours for meetings, support and context switching, a stricter allowance. The MVP scope uses 2,449 of the 2,646 hours (93%), which leaves 197 hours (7%) of margin for the unknown, mainly the first real casino integration. That margin is much thinner than the 26% to 57% of the previous version. The whole backlog (2,838 hours) is 192 hours over capacity, so P2 and P3 do not fit in the six months and stay deferred. If the 0.5 FTE product owner does no engineering, 3.0 FTE give 2,268 hours, 181 hours (7%) short of the MVP scope; the plan then defers the P1 tasks that no pilot operator depends on, a decision to take from the measured throughput of the first 90 days. If AI-assisted work does not speed things up as hoped, the capacity still covers the MVP scope, with the thin margin above.

What can be dropped and at what cost: the second backend engineer can go, at the price of dropping about 560 hours of P1 backlog (2,449 - 1,890; 2.5 FTE give 1,890 hours; they cover P0, 1,200 hours, but not P0 and P1, 2,449 hours) and losing independent review of money code (the founding engineer would rely only on the automated independent reviewer). The frontend engineer cannot be dropped without the design promise failing.

What AI tooling replaces and what it does not:

| Replaces or speeds up                                                                                                                | Does not replace                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| First drafts of specs, tests and code; adapter scaffolding from an API document; documentation and backlog upkeep; first-pass review | Choosing what to build and what earns money                              |
| Mechanical reviewer work: re-applying mutations, checking numbers                                                                    | Decisions about money invariants, tenancy and security boundaries        |
| Fixture and sample generation                                                                                                        | Talking to operators and casinos; a real casino's undocumented behaviour |
|                                                                                                                                      | Accountability for production: on-call, incident decisions               |

These estimates are for a human team. The AI-assisted process shortens the coding share, which is why the calendar is driven by external dependencies (Section 4). The speed-up from AI is not assumed in the team arithmetic above. Measure it (findings per change, time per change, escaped defects) in the first 90 days and reduce the team estimate only if the measurement supports it.

## 6. What to automate with AI

Answer: the loop of writing a specification, tests that fail, code, and an independent review, plus the upkeep that otherwise rots (contracts, backlog, docs). A human stays on every decision that moves money or crosses a trust boundary.

### The process in plain words

1. A person decides what the task is for and how much damage it could do. Each task gets a risk class: guard, identity, admission, budget, locks, concurrency, ownership, isolation or none. Anything other than none follows the full path below.
2. An AI writes a specification with testable acceptance criteria from the task.
3. A different AI session writes tests from the specification, without seeing any code. The tests must fail. If they pass, the tests or the premise are wrong.
4. A third session writes code until the tests pass. It may not change the tests.
5. An independent reviewer in a fresh session, on a stronger model, receives the code and the requirements, not the author's conclusions. It uses the running product. For each claimed fix it writes a regression test at the choke point (the place where a bad value cannot be constructed), then removes the guard (a mutation) and checks that the specific test goes red. It also checks that every new durable record is read back and described correctly, and re-runs the author's numbers.
6. Each re-review starts with the question "what did this fix move?" because a fix often moves a defect rather than removing it.
7. Merge only after green tests and updated documentation.

This follows the practice recorded in review-framework, a separate set of review rules kept by the product owner (not a dependency of this repository, and not needed to read it). The rules it contributes are the ones numbered above: the reviewer writes the regression test before the fix, a test sits at the choke point and not at the call site, one mutation per claimed fix is re-applied by the reviewer, every durable record gets a test that a reader consumes it, and each re-review asks "what did this fix move?". They are restated with examples from this repository in [`../ai/verification.md`](../ai/verification.md), so the section can be checked without access to review-framework. The coordinator does not write product code.

### Where else AI is used

- Contract reconciliation. Several parallel sessions write against shared contracts (events, adapter port, error codes). A reconciliation pass compares what each side produces and consumes, lists mismatches as questions, and the coordinator answers them once. It found duplicated definitions and conflicting names in this project before integration; the lesson is that every contract has one owner and the rest import it.
- Backlog upkeep. Tasks have a fixed format, and a mechanical check runs before each backlog change merges: every referenced id exists, no dependency cycle, no priority inversion, and the first-sellable-slice set equals the dependency closure of its two anchor tasks. AI proposes changes, the check decides.
- Documentation drift. A pass compares what documents say is Built with what the code and tests show, and flags the difference.
- Adapter scaffolding from a casino's API documentation, followed by the contract suite, never instead of it.
- Prompt evals, later. Prompt layering, evals and self-improvement of the agents' own prompts are low priority and come after the product earns money. The reason to wait: without a measured baseline of findings per change there is nothing to compare an eval against.

### What stays human

| Step                                       | Human check that stays                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Risk class and scope                       | The person decides                                                                               |
| Money, tenancy, auth specifications        | A person reads the spec before tests are written                                                 |
| Review of guard changes                    | A person reads the mutation evidence                                                             |
| DLQ and `NEEDS_REVIEW` redemptions         | A person decides; AI may summarise the case. An operator's word alone never moves coins or stock |
| Pricing, contracts, operator communication | The person                                                                                       |

### Risks and how they are contained

- Tests that agree with the code and prove nothing. Contained by writing tests before code, by a different session, and by the reviewer's mutations.
- Confident but wrong output. Contained by independent review that sees requirements, not the author's reasoning.
- Cost. Reviews on a stronger model are the expensive step, so they are reserved for tasks with a risk class other than none.
- Evidence. Keep a short log per change: what was generated, what the review found, what was fixed. The ratio of findings per change over time is the number that tells whether the process works.
