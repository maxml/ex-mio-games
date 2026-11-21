# How AI output was verified, and what went wrong

AI agents write plausible code and plausible reports. The process assumes both can be wrong and
checks them with things an author cannot fake. This page lists the checks, then the failures.

## Checks

### 1. Mutations, re-applied by the reviewer

A mutation removes or weakens one guard (a `WHERE` clause, a state check, a lock) and runs the test
that claims to protect it. If the test stays green, the test is vacuous. Rules:

- Every frozen test names, in its header, the mutation that must turn it red.
- The author reports one mutation per guard. That report is not evidence. The reviewer re-applies the
  mutation in its own checkout and restores it afterwards.
- Counts from the reviews in this repository: foundation, 13 mutations, 12 red and one hole in the
  layering lint; prototype round 2, 5 author-claimed mutations all red plus 2 reviewer-found gaps in the colour check and the paid-plan check, and round 3, 9 mutations, all red;
  identity spec re-review, 25 mutations, 23 red; ingest re-review, 8 mutations, 7 red and 1 vacuous
  claim; saga, 11 mutations, 9 red and 2 that survived.

### 2. Re-running the author's numbers

The reviewer repeats every claim ("tests pass", "build is clean", "all containers healthy in under a
minute") from a clean install of the committed SHA, never from the author's checkout. Examples that
reproduced: foundation, 13 of 13 projects lint and typecheck, 15 of 15 compose tests, nine containers
healthy in 59 s from a clean clone with no accounts; prototype, 17 of 17 then 29 of 29 tests, 28 colour
contrast pairs across 3 themes. Things the reviewer could not run are marked `unverified` in the review
(for example a screen-reader pass, or one UI claim read from code instead of clicked).

### 3. Fresh-context reviewers

Every reviewer and re-reviewer is a new agent on a stronger model (Opus) than the executors (Sonnet),
working in its own detached checkout of the committed SHA, and starts from files only. The reviewer
writes regression tests before the author fixes anything, so the test describes the property, not the
patch. The re-reviewer is told the previous reviewer's verdict only as data and is asked what each fix
moved. Several fixes did move the defect (go-live guard, payment attempts, wheel label direction), and
the re-review found it each time.

### 4. Tests at choke points

A fix is accepted only with a test at the point where a bad value cannot be built (the reducer, the
store, the guard, the database role), not at the call site where the symptom was seen.

### 5. Browser and live-stack probes

Where a property involves a real system, the reviewer used it: a headless browser click-test of the
prototype, a closed broker connection on the live compose stack, a probe as the service database role.
Several defects (double credit, no reconnect, an owner role that can drop row security) are invisible to
unit tests that use fakes.

### 6. The privacy check

The repository is public and allows a short list of names. A check (a grep for forbidden names, paths
and hosts, run over the tip and over the history, plus a check of commit author identity) runs on every
review and in the pre-commit hook. What it caught:

- starter-export commits in the history that carried hosting details and the name of another project,
  although the tip was clean. They were removed before publishing by squashing the history;
- a commit message on the prompts branch that pointed to a private source, reworded before merge;
- false positives from pinned action SHAs in the CI file, which the reviewer reported so the pattern
  could be corrected.

The reviewer also proved that the check itself is not vacuous: the control strings, known to be
forbidden, were detected before the real scan was believed.

### 7. Load and disk discipline

Rules written into every brief: check the 1-minute load and free disk before every heavy command;
wait while load is above 20; test runners use at most 2 workers and `nice`; build container images one
at a time; only one compose stack runs on the machine at a time, guarded by a file lock, always taken
down with its volumes before releasing; prefer in-process tests and use compose only where Postgres
row security or the broker is the thing under test; no background shells; before reporting, no process
the agent started may still be alive.

## What failed

Not everything above worked the first time.

- **Vacuous tests, written by AI test authors.** The identity spec's first round had three: a cache
  test that built a new verifier on every call, so no verifier ever saw the key set change; a loop over
  a constant it claimed to pin; and a row-level-security test over empty tables that passed even with
  the bypass granted. Ingest and payments each had several (a mocked method that made the named
  mutation unreachable, a route test on a hand-built module, a fault hook placed by the code under test).
  Only the mutation re-run exposed them. The author's report did not.
- **A reviewer's own spec was vacuous too.** In prototype round 2 the reviewer expected its committed
  regression spec to go red if the paid-plan check was dropped. In round 3, applying that exact mutation
  left the reviewer's spec green, because the spec had no account and failed on a different guard first.
  The author's own test caught the mutation. The reviewer recorded it so nobody would rely on the wrong
  test.
- **A false mutation claim.** An ingest test claimed that dropping a row lock would turn it red. A
  measurement over 30 runs showed it did not, and the claim was withdrawn in the next round.
- **Frozen tests that could not be satisfied.** Three identity tests expected a token to be expired 901
  seconds after issue, but a later decision added a 30 second leeway, so a correct implementation would
  fail them. The reviewer found it by building a reference implementation. Another frozen set had type
  errors that only a typecheck including tests would show.
- **Shell writes against the rule.** The process requires hand-written files to go through the editor
  tools, so every change is visible; the shell may only write a tool's output. In practice an executor
  wrote a types file with a Python script, four configuration files in the foundation were edited
  through the shell and the author's report naming them was not available, and reviewers disclosed shell
  writes for scratch fixtures and saved command output. Each was disclosed or discovered in review, the
  content was checked, and the prompts now say that unexplained shell writes are not acceptable.
- **An overloaded laptop.** Agents building container images in parallel pushed the 1-minute load to 48
  (reviewing the foundation, 34 even with `nice`, which only lowers the priority of the Docker client
  and not of the builder). During the prototype review the load reached 44 while another area built
  images, so that round stopped browser runs and the third round ran without a browser and says so.
  The disk reached 100% with 2.1 GB free; build caches, old images and package caches were cleared and
  about 40 GB came back. Agent shells left running in earlier work had piled up, and the owner made "no
  background shells" a rule for every brief. Load and disk are now checked before every heavy command.
- **The 3-round rule was exceeded once.** In Varta, the first ticket needed 8 re-review rounds although
  the rule says the coordinator decides at round 3. It was recorded as a lesson. In this repository the
  identity area got a third, deliberately narrow round, with a re-spec stated as the consequence of the
  same defect classes returning in a fourth.
- **Records written but never read.** Reviewers repeatedly found a written record with no reader: a
  dead-letter queue nobody consumed, a theme schema no check read, a sandbox flag no meter consumed. Reviewers
  now ask, for every durable record, for a test that a reader consumes it and describes it correctly.

## The integrated tree

After the areas were merged into one tree, a reviewer who had not written the code resolved the
frozen-test conflicts on the test side and ran the whole compose suite against the built images:

- First run 98 of 111 compose tests; second run 107 of 111 after test-side fixes. The 4 remaining reds
  were implementation bugs, each with a red test: a sandbox token could spend production spin credits,
  the casino credential served only one environment, the audit decision was taken from the HTTP status
  instead of the guard outcome, and a work-queue table had no row-level security. A fifth gap (the
  internal route that redeems a realtime ticket) also had red tests.
- Unit suites on that tree: payments 164 of 164, engagement 293 of 293, web 157 of 157, identity 231
  of 237, service-kit 122 of 127, contracts 99 of 102. The reds were the tests for the gaps above.
- Mutations re-applied by the reviewer on this tree: a forged-header scan, the acting-ban guard,
  the web theme token, the realtime audience list, row-level security on `wallets` and on the tenants
  registry, a dropped inbox key, a dropped ingest unique constraint. Each turned its named test red.
  Two guards (the bus backoff and one sandbox seed) could not be mutated without an image rebuild and are
  recorded as not verified by mutation.
- The coder then fixed the listed gaps on a separate branch against the frozen tests.

## What is not verified

- The end-to-end run of the final tree (compose up, the demo flow, the captured outputs) is recorded in
  the root README only where an output block is filled in.
- The one-sentence outcome of each review is the reviewer's, and the owner has not re-run them.
- Reviews that read code instead of running a browser are marked as such in the review text.
- No browser-driven run of the realtime socket against the full stack is recorded; the gateway is tested in process.
