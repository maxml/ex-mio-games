# Honest limits: what the AI got wrong and how it was caught

`verification.md` lists the checks. This page lists the misses, each with its evidence in the repo.

## What the AI got wrong

| What went wrong | How it was caught | Evidence |
| --- | --- | --- |
| Tests that could not fail: a cache test that built a new verifier per call, a loop sized from the constant it claimed to pin, a row-level-security test over empty tables | The reviewer deleted one entry or one guard and watched the test stay green | `defects-found.md` case 10; `verification.md` |
| A no-op left in place of a removed call, with a test that needed the no-op | The reviewer read the test against the decision and rewrote it | case study 5, `6d88297`, `11497e7` |
| A failure only the real stack showed (acting answered 500) | A reviewer test run under compose | case study 3, `223c35f`, `11497e7` |
| A money path nobody tested: sandbox token spends a production credit | End-to-end trace of one flag across four services | case study 1, `adb795a`, `1a810ae` |
| A durable record that said the wrong thing: audit decision from the status code, a `provider_links` row for an account that never existed | A reader-side test: read the record and check what it says | case studies 2 and 5 |
| Frozen tests that no correct code could pass: a token expected to be expired at +901 s after a 30 s leeway was decided | The reviewer built a reference implementation and ran the tests against it | `verification.md`, "Frozen tests that could not be satisfied" |
| Reviewer's own test was vacuous: it went green with the guard removed because it failed on a different guard first | A later round re-applied the mutation | `verification.md`, "A reviewer's own spec was vacuous too" |
| A mutation claim that was false (dropping a row lock) | 30 runs, no failure; the claim was withdrawn | `verification.md` |
| The same one-token SQL mistake in a helper and again in a test (`name[]` not cast) | Compose runs of the integrated tree | case study 4, `0335cea`, `8bb4701` |

## Fixes that moved the defect instead of removing it

These are the cases where a fix passed its own test and the reviewer found the defect next door.

- **Prototype, go live (case 1 in `defects-found.md`).** The first fix of the double-credit bug left the
  neighbouring rule on one button only, and the step bar let the player skip it. The reviewer's
  click-test found it, and the rule moved into the reducer. The payment attempt was the same shape: a
  timer nobody cancelled.
- **Identity spec, round 2.** The re-review's verdict: the fix round moved four defects to new places, and
  one of them left the frozen set unsatisfiable. The coordinator allowed exactly one more narrow round
  (D-14) and then made it a rule (D-17): a third round that still finds the same class means the spec is
  rewritten, and a fix that did not close its findings does not count as a round.
- **Identity finisher.** The no-op for D-21 B2 (case study 5) and the audit refusal that still left an
  intent to be swept as `aborted/500` were each the same defect class as an earlier finding, "coming
  back in a narrower form", in the reviewer's words.
- **Audit decision.** Fixing the status-code rule alone would have recorded engagement's acting ban as
  `allowed`, because it ran inside the handler. The fix had to move the ban into a guard (case study 2).
- **Sandbox.** Making every hop carry the sandbox flag was correct, and the defect moved to the credit
  table, which had no environment (case study 1).

Measured pattern. In this repository, the identity area needed three review rounds, and every area needed
at least one fix round at spec stage. Outside this repository, the review-framework lessons record the
same effect on a seven-ticket epic: no ticket passed its first hostile round clean, and in the last
four re-reviews the fix relocated the defect in three of four, two of two and three of three. Those
figures come from that project and cannot be re-run from this repository. They are the reason every
re-review brief asks "what did this fix move?" and every fix needs a test at the choke point, where a
bad value cannot be built, not at the call site where the symptom showed.

## What the process does not cover

- A second model family did not review. Executors are Sonnet and reviewers are Opus, both from one
  vendor, so a blind spot common to both is not tested.
- The owner did not read each diff. Verification rests on tests, mutations and compose runs that the
  reviewer re-applied, not on a human reading the code.
- Two guards (the bus backoff, one sandbox seed) could not be mutated without an image rebuild, and
  the realtime socket has no browser-driven run on the full stack. Both are listed in `verification.md`.
- Review summaries are the reviewer's own. The owner has not re-run them.
- Not every defect has a review file behind it. Case study 6 rests on commits and a test only.
