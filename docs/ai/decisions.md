# Human decisions and AI proposals

The owner is the human who set the direction. The coordinator is an AI agent that planned the work,
recommended options and made the narrower technical calls the owner delegated.
All dates are 2026-11-21; "round" is the owner's answering round that day. The column "AI
proposal overruled" says whether the owner chose something other than what the AI had recommended.

## Decisions by the owner

| Date, round | Decision | AI proposal overruled | Why |
| --- | --- | --- | --- |
| 11-21, r1 | Reuse the monorepo starter; if it must change, update it first, then reuse it | no | A better starter pays back in every later project |
| 11-21, r1 | TypeScript on front end and back end; microservices; all payments in their own service; a message broker is mandatory | no | The system will grow, so the structure should be right from the start |
| 11-21, r1 | Tenants are not their own service; the admin console is its own tenant; a user is keyed by `tenant_id + user_id` | no | Keeps the expensive-to-change part simple |
| 11-21, r1 | Casino integrations are a module inside one service, not a service | no | One more deployable adds cost and no isolation benefit yet |
| 11-21, r1 | Observability lives in Varta; deploys through Deckhand | no | Reuse what exists, invent nothing |
| 11-21, r3 | Message broker is RabbitMQ | **yes**: the AI recommended a Kafka-compatible log (Redpanda locally) for history and replay | The owner only needs acknowledgement of receipt from the broker; everything else can live in Redis or the database. Smaller to run |
| 11-21, r3 | ORM is TypeORM | **yes**: the AI proposed deciding between Prisma, Drizzle and Kysely after an RLS comparison | "Why invent anything": isolation, ledger and idempotency are enforced in Postgres (row-level security, constraints, roles), so the choice of ORM does not matter to the architecture |
| 11-21, r3 | Payment provider: `fake` by default, `stripe` switched on by a key | no (the AI's own recommendation, approved) | The demo does not depend on an external account; billing stays real in test mode |
| 11-21, r3 | Coins: the balance may be read anywhere; every credit, debit and refund goes through the payments service only | no | One place to prove the money rules |
| 11-21, r3 | Identity sits behind an interface; Firebase first, Cognito later | no | Swappable provider |
| 11-21, r3 | The repository is public; allowed mentions are Varta, Deckhand, the monorepo starter, review-framework, Shemsedinov, maxml | no | Owner's call on what other projects may be named |
| 11-21, r4 | Identity runs on a local Firebase emulator; production provider choice is deferred; a clean clone must run without accounts | no | Another person must be able to run it |
| 11-21, r4 | All analytics go through Varta, one panel; a third-party tool may be plugged into Varta | **yes**: the AI's analytics tasks planned a separate product-analytics stream and storage | The owner wants one panel for everything, and Varta was written for that |
| 11-21, r4 | The ledger is database tables in the payments service, never files | no | Hard requirement for money |
| 11-21, r4 | Per-service secrets in Deckhand: do nothing now; the product says nothing about them; decide later | **yes**: a reviewer found that all services share secrets at deploy level and recommended fixing it, the AI planned a Deckhand task | The owner wants it solved differently and later; the product claims no deployment-level isolation until then. DB-level isolation (separate roles, row-level security) is still built and tested |
| 11-21, r4 | Docs folder for decisions is `docs/adrs` | **yes**: the AI's first plan and layout used `docs/adr`, and an independent reviewer listed the `adr`/`adrs` mismatch as a defect | The owner's naming. The reviewer's finding was closed as "not a defect, keep `adrs` everywhere" |
| 11-21, r4 | Starter knows nothing about projects that use it; Nx module boundaries are mandatory | no | The starter stays generic; many modules will exist, boundaries must hold |
| 11-21, r7 | Deadline is two days (evening of 2026-11-22); MIO is built directly in the product and generic parts move into the starter afterwards | **yes**: the AI's earlier plan was a full-scale build with the starter updated first | "Bad, but OK, this project is more important." The 8-hour limit from the task was already ignored, now the time limit is two days |
| 11-21, r7 | The diagram generator stays in scope despite the deadline | **yes**: the AI proposed dropping it to save time | Owner: "what did it get in the way of?" It was kept |
| 11-21, r5 and r7 | Agents build one Docker image at a time, run tests with at most 2 workers, and only one compose stack runs on the machine | **yes**: agents had been building images in parallel | The laptop hit a load of 48 and a full disk (see `verification.md`); the owner made it a rule for every brief |
| 11-21, r2 | Role prompts live inside the project; reviewing is done by another session than the one that wrote the code | no | Independence of review |
| 11-21, r6 | Owner approved the AI's recommendations on the review process: red tests before code only for risky classes, shell writes only for tool output, and so on | no | Keeps the process affordable |

## Decisions made by the coordinator (AI) and kept by the owner

The owner delegated technical calls inside the owner's rules. The coordinator recorded each as a
numbered decision, usually in answer to a reviewer finding. The owner can reverse any of them.

| Decision | Reason it was needed |
| --- | --- |
| D-1: only payments credits coins for a spin; engagement writes a `spin.completed` event in the same transaction as the result, payments credits from its inbox with key `spin:<id>` | A review showed engagement was designed to call a credit endpoint, which broke the owner's "payments owns every coin" rule |
| D-2: one casino adapter port, defined once in the shared contracts; a refund is allowed only after a definite rejection | Two areas had each defined their own port |
| D-4: services call each other with short-lived service tokens that carry no tenant; the tenant is an explicit parameter on allow-listed routes | Trusting a header for the tenant was a hole |
| D-5, D-14: payments refuses any coin operation from an acting (impersonating) token; each service client has an allow-list of routes | An administrator acting as a user must never be able to move coins |
| D-8: redemption returns 409 right away for insufficient funds; replay of a review is allowed only if it was entered from the unknown state | Two money defects found in the saga review |
| D-10: realtime keeps connection-state recovery off; the socket uses a one-time ticket | The starter's security finding: recovery bypasses auth in the library version used |
| D-12, D-13: sandbox traffic is flagged by the producer from server-side state; sandbox uses separate wallets | A sandbox flag must not be able to remove a paid operation from the bill |
| D-15: webhook auth uses each casino's own signature scheme; operator word alone never moves coins or stock | Reconciliation of the contracts between areas |
| Re-spec rule: after three review rounds that find the same class, rewrite the spec instead of patching | A patch loop on one area did not converge |

## What the table shows

- 8 owner decisions overruled an AI recommendation. In each, the AI had presented options and a
  recommendation, and the owner picked a different one or a smaller scope. The AI changed its plan the
  same day and recorded the owner's reason.
- The owner's decisions are mostly about cost of change and about what to publish; the AI's decisions
  are mostly about invariants inside one area, and each was triggered by an independent reviewer
  finding rather than by the author.
- Two AI recommendations were approved without change: the payment provider split and the review
  process.
