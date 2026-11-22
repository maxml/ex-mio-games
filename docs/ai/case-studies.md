# Six case studies: defect, how it was caught, fix, pinning test

Every SHA below is a commit on the integration branch at `1aa98e0` and can be opened with `git show <sha>`. Every test name can
be found with `grep -rn "<name>" apps packages tests`. The process behind each case: a spec and red
tests written by one agent, code written by a separate coder against the frozen tests, a hostile
review by a stronger model that re-applies mutations itself, and the question asked of every fix:
"what did this fix move?". `defects-found.md` holds more, smaller cases; `limits.md` lists what the
process got wrong.

| #   | Defect                                                   | Caught by                                                | Fix                  | Pinning test                                       |
| --- | -------------------------------------------------------- | -------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| 1   | A sandbox token spent a production spin credit           | reviewer of the integrated tree, red test before the fix | `f113368`            | `INV-SPIN-ENV-DB`                                  |
| 2   | Audit decision taken from the HTTP status                | same review, at the choke point                          | `f113368`, `f2c4d80` | `D-24 a later guard that refuses...`               |
| 3   | Acting returned 500 on the real stack, unit tests green  | reviewer ran compose                                     | `07651b9`            | `M1 reader: the final audit record is consumed...` |
| 4   | An unparsed `name[]` column in the tenant-key helper     | reviewer's verify round on compose                       | `58d5fd6`, `b43d404` | `INV-ENGAGEMENT-SCHEMA-DB`                         |
| 5   | A test that passed only because a no-op was still called | mutation re-applied by the reviewer                      | `3c92da3`, `07651b9` | `INV-LAUNCH-1`                                     |
| 6   | Websocket pushes could leave before the commit           | review of the realtime gateway                           | `d102576`, `615f174` | `COMMIT-ONLY` (2 tests)                            |

## 1. A sandbox token spent a production spin credit

- **Defect.** Identity maps a casino player to one user per tenant, platform and casino id, so a
  sandbox launch and a production launch are the same user. Engagement's `consume()` and
  `countAvailable()` had no environment condition, and the spin was flagged sandbox when the token was.
  A sandbox token therefore spent a credit bought by a production deposit.
- **Money impact.** The coins went to the sandbox wallet, and the spin was marked sandbox, so
  metering skipped it. A production credit was consumed and a paid operation left the bill. The owner's
  rule (decision D-13) is that a sandbox flag must never be able to do that.
- **How it was caught.** The reviewer traced one sandbox flag end to end across four services. Every
  hop was correct, and the gap was in the credit table. It wrote a red test first (`fd7d690`): with
  one production credit, the sandbox token must see `available: 0` and get `409 no_credit`.
- **Fix.** Credits are per environment, like wallets: consume and count filter on the token's
  environment (`f113368`, `apps/engagement/src/model/pg-repositories.ts`).
- **Pinned by.** `INV-SPIN-ENV-DB` in `tests/compose/src/ingest.compose.test.ts`, on real Postgres.
  The header names the mutation: drop the environment condition from the consume query or from
  `countAvailable`. That test also checks that the production token can still spend the credit.
- **What the fix moved.** Nothing found. The review's note on this fix: a sandbox launch for a real
  production player should never happen, but the operator picks which credential launches, so the
  database has to refuse it.

## 2. The audit decision came from the HTTP status, not the guard

- **Defect.** The shared auth entry point wrote `decision = statusCode < 400 ? 'allowed' : 'refused'`
  for every request carrying an acting token. A handler answering 404 was recorded as `refused`. The
  audit log is a durable record, and it described the request wrongly.
- **Decision.** D-24: the decision is the authorization outcome. `refused` only when a guard refused.
  If a guard let the call through and the handler later answered 404, the record is `allowed` with
  status 404. The reviewer ruled this an implementation bug, not a conflict in the tests.
- **How it was caught.** The compose test `INV-STACK-8` was red on the real stack. The reviewer also
  looked ahead: after the fix, engagement's acting ban would run inside the handler and be recorded as
  `allowed`. So the ban had to become a guard.
- **Fix.** `f2c4d80` and `f113368`: the decision follows the guard outcome in
  `packages/service-kit/src/service-auth.ts`, and engagement's acting ban moved into
  `apps/engagement/src/controllers/acting-ban.guard.ts`.
- **Pinned by.** `packages/service-kit/src/service-auth.test.ts`: "D-24 a later guard that refuses
  writes refused/403 and the handler never runs; a handler that answers 403 itself writes allowed/403",
  and "an acting request whose handler throws 404 writes exactly one allowed event carrying status 404".
  Both use a later guard and a failing handler as separate fixtures, so neither can pass by testing
  the status code alone.

## 3. Acting returned 500 on the real stack; the unit tests were green

- **Defect.** `POST /v1/auth/acting` answered 500 `TenantMismatchError` for a platform admin. The audit
  write inside `SessionsService.startActing` switched tenant while the request's ambient tenant was the
  platform tenant. The in-memory store used by unit tests did not enforce the ambient-tenant rule that
  the Postgres transaction helper enforces.
- **How it was caught.** A reviewer wrote a reader test: an acting request must show in
  `GET /v1/audit` with its real decision. It ran under compose and failed one step earlier, on the 500.
  The test is in `37ab302`. The review recorded the class: a failure invisible to in-memory tests.
- **Fix.** `07651b9`: write the `acting.start` audit row without switching tenants mid-request, and make
  the memory store refuse a tenant that differs from the ambient one, so unit tests see the same error.
- **Pinned by.** `M1 reader: the final audit record is consumed and described correctly (D-11, D-21)` in
  `tests/compose/src/audit-intents.compose.test.ts`, which runs against Postgres.
- **Why compose runs matter.** Without a run on the real stack, platform admins could not impersonate
  anyone, and the unit tests said everything was fine. The fix also closed the gap in the fake.

## 4. One unparsed column type broke the tenant-key check

- **Defect.** `ensureTenantKeys` in `packages/tenancy/src/rls.ts` aggregates index columns with
  `array_agg(a.attname ...)`. Postgres types `attname` as `name`, so the result is `name[]`, which
  node-pg does not parse into an array. The helper compared a string such as `{tenant_id,id}` with an
  array. It runs inside `enableTenantRls`, which every tenant-table migration calls, so the error sat
  under all of them.
- **How it was caught.** The reviewer's verify round on compose. In the later integrated run the same
  mistake appeared in a frozen test, in the unique-column scan of `INV-ENGAGEMENT-SCHEMA-DB`, and the
  reviewer fixed it on the test side with the same cast.
- **Fix.** `array_agg(a.attname::text ...)`: `58d5fd6` (code) and `b43d404` (test).
- **Pinned by.** `INV-ENGAGEMENT-SCHEMA-DB: the UNIQUE constraints exist on exactly these columns`
  in `tests/compose/src/ingest.compose.test.ts`, and the roles test in
  `tests/compose/src/roles.compose.test.ts`, which run on real Postgres.
- **Note on size.** The number of tests this took down is not recorded in the review files, so none is
  claimed here. The lesson: the same one-token mistake lived in a helper and a test that copied it.

## 5. A test that passed only because a no-op was still called

- **Defect.** Decision D-21 says players do not use the identity provider: a casino launch token is
  enough, and identity issues its own player token. The finisher "removed" the provider call by making
  it a no-op, and kept calling it. The frozen test `INV-LAUNCH-1` asserted "one provider call". It
  passed because the vestigial call still happened, and it pinned the opposite of D-21.
- **How it was caught.** The reviewer read the test against the decision, then wrote a corrected
  `INV-LAUNCH-1` (`3c92da3`): launch makes no provider call and stores no provider link for the
  player. It was red on the finisher's code.
- **Fix.** `07651b9` removed the call, the port method `exchangeLaunchToken` and the `provider_links`
  row from the launch path, and both adapters.
- **Pinned by.** `INV-LAUNCH-1` in `apps/identity/src/identity.launch.test.ts`.
- **Why it matters.** The no-op also left a row claiming a provider account that did not exist. A
  durable record described something false. The review counted this as the same defect class as an
  earlier one coming back in a narrower form, which falls under the round limit (see `limits.md`).

## 6. Websocket pushes were not tied to the commit

- **Defect.** The first realtime gateway (`338aee0`) pushed from the bus consumer as soon as the
  handler produced an event. If the handler's transaction then rolled back, the player had already been
  told about a spin result or balance change that never became true.
- **How it was caught.** Checking the gateway against the delivery rule (a push must never describe
  something the database did not keep). This case has no separate review file; the evidence is the
  commits and the test, which was written to fail against an inline publish.
- **Fix.** `d102576` queued each push against the handler's transaction and flushed it on commit,
  dropping it on rollback. `615f174` then replaced that code with the logger's `afterCommit`, so
  product events and websocket pushes share one after-commit mechanism.
- **Pinned by.** `apps/engagement/src/realtime/realtime.gateway.test.ts`, two tests named `COMMIT-ONLY`:
  a handler that throws after queueing delivers no push; a committed handler delivers exactly once and
  only after commit. The first test asserts that nothing arrived while the transaction was still open.
  The header names the mutation: call `publish` inline in `queue()`.
- **What the fix moved.** The refactor in `615f174` kept the tests and changed the mechanism. It moved
  one duplicated rule into one place.
