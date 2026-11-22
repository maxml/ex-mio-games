# Defects that independent AI review caught before merge

Each case below was found by a reviewer agent that did not write the code, using either a mutation
(remove a guard, see which test stays green) or a probe (a new test or a hostile input). Authors had
reported their work as passing every time. SHAs are commits in this repository's history; some are on
branches that are not merged into `main`.

Two kinds of defect appear: wrong behaviour in the product, and tests that could not fail. The second
kind matters as much as the first, because a test that cannot fail gives false confidence.

## One fully traced example: the prototype paid out a spin twice

| Step                                  | What happened                                                                                                                                                                                                                                                                                                                                                                     | Reference                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1. The defect                         | Prototype v1. The wheel component credited the last spin from an effect that ran on mount. The widget unmounts the wheel when the player changes tab, so spinning, opening the Store tab and returning credited the same prize again                                                                                                                                              | `531ae65`                    |
| 2. How the reviewer found it          | A click-test in a real browser: 445 coins, spin, Store tab, back to Wheel: 470 coins and a new history row without a spin. Reproduced in two runs. A related defect from the same root: switching tab during the 4.2 s animation consumed the spin and showed no coins until the player came back                                                                                 | review round 1               |
| 3. What the reviewer asked for        | Not a patch at the call site. Credit when the result arrives, in the one place that stands in for the server, keyed by a spin id; the wheel only animates and ignores a result it already holds when it mounts. The test the reviewer specified: mount the wheel with a non-null result and assert that it reports no spin end                                                    | review round 1               |
| 4. The fix                            | The credit moved into the store reducer, keyed by spin id (a spin id is credited once). The wheel remembers the last id it saw and starts from the id it was given at mount                                                                                                                                                                                                       | `cadcce7`                    |
| 5. The tests that pin it              | `Wheel.test.tsx`: "mounted with a result already in hand: no animation, no onSpinEnd (the old re-credit bug)" and "unmount and remount with the same result does not report it again". `store.test.ts`: "replaying the same spin id (what a remount used to do) changes nothing" and "subscribing and unsubscribing views never moves the balance"                                | `cadcce7`                    |
| 6. The mutation that turns them red   | The reviewer removed the spin-id check from the reducer: `store.test.ts` "replaying the same spin id" went red, 1 of 17. Separately the reviewer replaced the wheel's initial `handled` value with `null`: the 2 remount tests went red. Both were restored afterwards                                                                                                            | review round 2, at `cadcce7` |
| 7. What the fix moved                 | The reviewer re-ran the browser scenario (445 stays 445, history rows 4 stay 4), then looked for new ways to get the same double credit: a double click (one spin consumed), routing away mid-spin (one credit), two browser tabs (separate in-memory stores, so nothing to double-credit; the real ledger must repeat the id check on the server). It did not find a second path | review round 2               |
| 8. The reviewer's own regression spec | The reviewer committed its own properties for the neighbouring money rules found in the same round (`e8792eb`). Those found two further defects in the fix (go-live without a paid plan, and a payment for a cancelled plan, cases 1 and 2 below), fixed in `069743c`                                                                                                             | `e8792eb`, `069743c`         |

Outcome: round 3 re-ran 29 of 29 tests and 9 mutations, all red as expected, and recommended merge.
It was merged in `1eebc05`. The suite had 17 tests at `cadcce7` and 29 at `069743c`.

## Other defects, in the order they were found

### 1. Go live without a paid plan (prototype)

- **What.** After the first fix, the operator console let a casino reach "You are live" with no
  account and no paid plan. The paid-plan check existed only on the Continue button, and the step bar
  allows jumping anywhere.
- **How found.** Click-test: step bar, sandbox, go live. Also a mutation: flipping the button's check
  to `true` left all 17 tests green, so nothing pinned it.
- **Fix.** The rule moved into the reducer: go live needs an account, a paid plan and a passed
  sandbox (`069743c`).
- **Pinned by.** `store.test.ts`: "go live needs a paid plan even with an account and a passed
  sandbox", plus matching tests for the account and the sandbox. Mutation: dropping `planActive` from
  the guard turns exactly that test red.

### 2. Payment recorded for a cancelled plan (prototype)

- **What.** Pay for the Growth plan, press Cancel within 150 ms, pick Starter: 1.1 s later the console
  said "Starter, paid" and billing showed a Starter invoice as paid. The Cancel cancelled nothing and the
  plan on record was not the one the card was charged for.
- **How found.** Click-test and code reading (a timer that nothing cancelled, and an invoice action that
  stored neither plan nor amount).
- **Fix.** The payment attempt (id, plan, amount from the price list, outcome) moved into the store. The
  reducer marks Paid only for a live attempt, and a plan change during an attempt is refused (`069743c`).
- **Pinned by.** Store tests: "a late provider answer for a cancelled attempt never pays", "the plan
  cannot change while an attempt is in flight, nor after payment", "cancel aborts the attempt". The
  reviewer re-applied four mutations, one per guard, and each turned its test red.
- **What it moved.** One older action still wrote "Paid" without an attempt. It is unreachable from the
  UI and was recorded as a minor finding for the Storybook task.

### 3. Outbox head-of-line blocking (foundation)

- **What.** The relay took the first 50 unpublished rows each pass. Events nobody consumed were
  returned by the broker as unroutable and never marked, so 50 of them filled every batch forever and
  starved routable events behind them.
- **How found.** A probe on the live stack: the payments outbox held 6 of 6 rows unpublished and the
  broker counted about 11 republishes per second, growing with every credit. A reviewer property test
  was red.
- **Fix.** Attempts, next-attempt time and a parked state with backoff (`0c7ef63`).
- **Pinned by.** New cases in `packages/bus/src/bus.test.ts` and the reviewer's compose property tests
  (`8be77d8`).

### 4. No reconnect to the broker (foundation)

- **What.** After the broker dropped connections, all three services stayed unhealthy with 0 broker
  connections and 0 container restarts. Docker does not restart an unhealthy container, so a running
  service never recovered.
- **How found.** A probe: close all broker connections and read the readiness endpoint at +2 s, +15 s
  and +45 s. It stayed 503.
- **Fix.** Reconnect with backoff (500 ms up to 15 s by default), re-creating channels and topology
  (`0c7ef63`).
- **Pinned by.** Tests added in `packages/service-kit/src/ops.test.ts` and compose resilience tests
  (`daba327`).

### 5. The database owner role could switch off tenant isolation (foundation)

- **What.** Each service's database role owned its tables. An owner can run
  `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and then read every tenant. Injected SQL in the service,
  or a careless migration, needs one statement.
- **How found.** A probe as the service role: the same query went from 0 rows to 6 rows across 4 tenants.
- **Fix.** Two roles per service. An owner role runs migrations; an app role is not the owner, has
  `NOBYPASSRLS`, and has only the grants listed in one migration (`4324fbf`).
- **Pinned by.** Reviewer property T3 (`8be77d8`), compose role tests (`daba327`), and a test that pins
  the exact grants.

### 6. A forged tenant header in production (foundation)

- **What.** The tenant came from an `x-tenant-id` header and nothing stopped a production boot with
  that placeholder, with `/v1/credits` routed publicly: anyone could credit coins to any tenant.
- **How found.** Reading plus reviewer property T6.
- **Fix.** The tenancy module throws on boot in production unless a verified-token resolver is passed,
  and the silent header fallbacks were removed so a wiring mistake fails closed (`d152488`).
- **Pinned by.** Tests in `packages/tenancy/src/tenancy.test.ts`.

### 7. Redemption saga returned stock twice, and replay could pay a reward with no coins held (store)

- **What.** Two money paths found while reviewing the specs and red tests, before any saga code. A
  redemption released, then revived by a late success, then marked "not issued" by an operator, released
  its stock a second time. And replaying a review entered after the coins were released led to a second
  reward being issued with nothing held.
- **How found.** The reviewer wrote a throw-away reference saga of about 200 lines to check that the
  frozen tests were satisfiable, then probed the two sequences. All 35 frozen saga tests stayed green
  against both defects. Two of the 11 re-applied mutations also survived, including "call the casino
  before the issuing state is stored".
- **Fix.** Release is conditional on the reservation being in `reserved` state, enforced at the store.
  Replay is allowed only for a review entered from the unknown state, enforced in `apply`. For
  the adapter-before-commit mutation the reviewer asked for a wrapper outside the saga's control that
  records the stored state at each casino call. The store and saga tests were fixed and frozen in
  `c92431a`; the mutation re-run on the final code belongs to the coder's review, which was still
  in progress.
- **Pinned by.** `store-conformance.ts`: "releasing the reservation twice restores stock once" and
  "stock is returned exactly once through release, review and not_issued"; saga test
  "I-REPLAY-1 replay of a review entered after RELEASED is refused: the casino is never asked again".

### 8. Sandbox spins credited the production wallet (contracts, across areas)

- **What.** The payments tests asserted that a sandbox spin still credits coins into the player's only
  wallet, and the saga's fake payments ignored the sandbox flag. A sandbox player could end up spending
  production coins.
- **How found.** Reconciling the contracts of the four areas against each other; the reviewer read
  one area's test against another's decision.
- **Fix.** Decision D-13/D-15: wallets are per environment, the credit picks its wallet from the
  producer-set flag, reserve and release use the reserve's own wallet. The wrong test was marked for
  rewriting to "sandbox spin credits the sandbox wallet, production balance unchanged, meters nothing".
- **Status.** The decision and the contract are recorded; the code change is part of the service work
  that was still in progress when this page was written.

### 9. `/%69nternal/` reached an internal route (identity)

- **What.** The spec said service mode is chosen by the path prefix `/internal/v1/`. The framework
  decodes `%69` to `i` when it matches the route, so a user token for tenant B sent to
  `/%69nternal/v1/tenants/A/ping` got a 200 in user mode.
- **How found.** The reviewer reproduced it on a reference implementation of the obvious reading of
  the spec. The frozen tests only used canonical URLs, so they would have passed.
- **Fix.** Spec: the mode comes from the matched route (an internal marker read by the reflector),
  never from the raw URL. Decision D-14 (`4b408a4`).
- **Pinned by.** `identity.http.test.ts`, "INV-S2S-3 an operator token on an encoded internal URL ...
  is never served", plus a test that every internal route carries the marker.

### 10. Tests sized from their own constant (identity, ingest, payments)

- **What.** A loop over the list of coin actions was built from the same constant the test claimed to
  guard. Remove `coins.capture` from the constant and the loop shrinks, the test stays green, and the
  hole is not covered. The reviewer's first round on identity found three tests that could not fail
  (a cache test that built a new verifier each time, this sized loop, and a row-level-security test
  that read empty tables).
- **How found.** Mutation: delete one entry from the constant.
- **Fix.** The tests use a literal list, and a separate contract test pins the constant against the same
  literal, in the identity fix rounds (`bd60eb2`, `4b408a4`).
- **Pinned by.** The explicit matrix rows in `identity.access.test.ts` and the contract pin test.
- **Same class elsewhere.** A claimed mutation "drop SKIP LOCKED" in ingest turned out not to fail in
  30 of 30 runs (the lock was irrelevant under that isolation level), and the claim was withdrawn.
  A public-credit-route test in payments built its own module and never saw the real route table.

## What the list shows

- The most expensive defects were in places a test author could not see: a reachable path nobody
  thought of (cases 7, 9), or a test that passes for the wrong reason (cases 1, 10).
- Cases 7 to 10 were caught at specification and red-test stage, before any service code existed,
  which is why the review of specs and tests is part of the process.
- The authors' reported numbers reproduced in the reviews cited here. The reviews found properties
  the authors' tests did not pin, not false reports.
