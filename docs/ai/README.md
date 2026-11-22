# How AI was used to build MIO

This folder is the evidence for Part D (AI-native development). Almost all of the code, tests,
specs, backlog and documents in this repository were written by AI agents. A human owner set the
direction and made every decision that was expensive to change. A different set of AI agents tried to
break each piece of work before it was merged.

## Summary in ten lines

1. Planner AI wrote a backlog of 17 epics and 133 tasks before any code (commit `b6fc551`); the backlog later grew to 142 task files.
2. A separate reviewer found 2 blockers and 8 major problems in that backlog, fixed in `44e5a98` and `d31f1a5`.
3. Each risky area went spec, red tests, review, code to green, review. Coders may not edit frozen tests.
4. Reviewers are fresh Opus sessions that re-run the author's numbers and re-apply one mutation per claimed guard.
5. At most three review rounds per area; a third repeat of a defect class means a re-spec (D-17, D-26).
6. Owner decisions that overruled an AI recommendation: 8 (`decisions.md`); every `D-<n>` resolves in `../decision-log.md`.
7. Counts such as "107 of 111 compose tests" and "12 of 13 mutations red" are reviewer reports; only the demo run (40 steps, 194 assertions) is recorded, in the root README (known gaps S-12).
8. Failures are recorded, not hidden: vacuous tests, false mutation claims, fixes that moved a defect (`limits.md`).
9. Everything on this page happened on 2026-11-21, with a deadline of the evening of 2026-11-22.
10. This folder is about 9.5k words; start with this summary, then `case-studies.md` for six traced defects.

| File                 | What it shows                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `README.md`          | This page: the process, the roles, the models, where the prompts live                                                      |
| `decisions.md`       | Human decisions against AI proposals, including the ones where the human overruled the AI                                  |
| `defects-found.md`   | Defects that independent AI review caught before merge, with the test that now pins each one, and one fully traced example |
| `verification.md`    | How AI output was checked, and what went wrong along the way                                                               |
| `case-studies.md`    | Six defects on `int/rc`: how each was caught, the fixing commit and the test that pins it                                  |
| `../decision-log.md` | What each `D-<n>` cited in tests and comments means, with the reason and where it is enforced                              |
| `limits.md`          | What the AI got wrong, fixes that moved a defect, and what the process does not cover                                      |

All of it happened on one day, 2026-11-21, with a deadline of the evening of 2026-11-22. The numbers
below come from that run.

## The work, step by step

1. **Plan.** An AI planner read the task, the owner's rules and the existing assets (the monorepo
   starter, Varta for observability and analytics, Deckhand for deploys). It wrote a plan, a backlog of
   17 epics and 133 tasks (commit `b6fc551`), and a list of questions for the owner. The owner answered
   in rounds; each answer is recorded in `decisions.md`.
2. **Backlog review.** A separate reviewer session reviewed the backlog at `b6fc551` before any code
   existed. It found 2 blockers and 8 major problems (dependency cycles, a saga that promised atomicity
   across two databases, a sandbox that could bypass billing). They were fixed in `44e5a98` and
   `d31f1a5`. The AI-readiness rules were set at this stage too.
3. **Design first.** A clickable design prototype came before the services (`698dd94`, then `f8e2380`).
   It went through three review rounds (`d1460a2`, `b0e2878`) and was merged in `b0776d5`.
4. **Specs and red tests.** For each risky area (identity, payments, ingest and spins, bonus store and
   redemption saga) a spec author wrote a contract and a test author wrote failing tests from it, before
   any implementation. A review of the specs and tests ("Stage A") followed. Every area needed at
   least one fix round (identity needed three), and the specs and tests were fixed and then frozen.
5. **Code to green.** A fresh coder implements against the frozen tests. The coder may not edit them.
   If a frozen test is wrong, the coder stops and reports.
6. **Independent review.** A reviewer on a stronger model works in its own checkout of the committed
   SHA. It re-runs every number the author claims, writes regression tests of its own, and applies
   one mutation per claimed guard: it removes or weakens the guard and checks that the named test turns
   red. A guard whose mutation stays green is a finding.
7. **Re-review.** A second reviewer takes the fix commit and asks one question of every fix:
   "what did this fix move?" A fix that removes the symptom often moves the defect to a neighbouring
   path, so the re-reviewer probes the neighbours.
8. **At most three rounds.** If round three still finds the same class of defect, the work is not
   patched again. The coordinator re-writes the spec. This rule is written into the coordinator
   decisions (the identity area got exactly one more narrow round, with a re-spec as the stated
   consequence of a repeat).
9. **Documents in the same merge.** A docs author updates the permanent documentation when the code
   merges.

Every role is a fresh agent for each step, round and task. Its only input is files in the repository
and the brief it is given. Nobody carries a conclusion in memory from one round to the next.

## Roles and models

| Role        | Model  | Writes                                  | Does not write  |
| ----------- | ------ | --------------------------------------- | --------------- |
| Coordinator | Opus   | briefs, decisions, merge order          | code            |
| Spec author | Sonnet | spec, contracts, state tables           | tests, code     |
| Test author | Sonnet | failing tests, frozen                   | production code |
| Coder       | Sonnet | production code until frozen tests pass | tests           |
| Docs author | Sonnet | permanent documents                     | code            |
| Reviewer    | Opus   | its own regression tests, a review file | production code |
| Re-reviewer | Opus   | probes and a verdict on each fix        | production code |

Executors run on Sonnet because the work is well specified and cheap to repeat. Reviewers run on the
stronger Opus model because a reviewer has to find what the author did not think of, and an author
and a reviewer on the same model share blind spots. Commits made by the executors end with a
`Co-Authored-By: Claude Sonnet 5.5` line.

The role prompts are in `prompts/` (one file per role, the brief templates, and an evidence table the
reviewer fills in before a merge). The thin agent definitions that restrict each role's tools are in
`.claude/agents/` (for example, the reviewer cannot touch production code, and the spec author has no
shell). A structural check, `ci/check-prompts.sh`, runs in CI and in the pre-commit hook and fails if
a role loses its wrapper, a placeholder drifts from its table, or a filled brief grows past 3072 bytes.

## What the human did

The owner did not review each diff. The owner decided what was costly to reverse (broker, ORM,
tenancy model, where coins live, what may be mentioned in a public repository, the deadline) and
approved or rejected the coordinator's recommendations in rounds. `decisions.md` lists these
decisions, including 8 in which the owner overruled an AI recommendation.

## What the process produced

- Foundation review at `2d8e1f3`: 18 findings (5 major). 12 of 13 reviewer mutations on guards
  went red, and one hole was found in the layering lint. 8 reviewer property tests failed on purpose
  until the fixes landed.
- Prototype: 3 rounds, 15 findings in round 1, 2 major in round 2, 0 in round 3 (2 minor remain
  recorded as known gaps). Tests grew from 0 to 29.
- Identity, ingest, payments and store specs: each had a first review that found vacuous tests
  (tests that cannot go red) and contract mismatches between areas; those mismatches were reconciled
  before any service code was written against them.
- Integrated tree: 107 of 111 compose tests after the reviewer's test-side fixes, with the 4 remaining
  reds all implementation bugs that the reviewer pinned with a red test before the coder fixed them
  (see `verification.md`).

`defects-found.md` gives the individual cases.
