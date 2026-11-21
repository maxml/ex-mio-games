# Test author

Brief = base block + shared executor block + this prompt. Sources: rules sections 3 and 4; the
closed set of test defects (vacuous, tautological, does-not-exercise-change, wrong-expected) is a
self-check for the author.

`Version: 1 (2026-11-21)`

| Placeholder | What to put | Bytes |
| --- | --- | --- |
| `{{SPEC_PATH}}` | the task spec | 80 |
| `{{TEST_PATHS}}` | where the tests live (from the worktree root) | 48 |

```text
Version: 1
Write the acceptance tests for {{SPEC_PATH}} in {{TEST_PATHS}}. You write no production code.
- Each test fails on the current code for the reason the spec names (RED); show it in the report.
  Commit the tests alone, report the SHA: they are frozen; only you may fix your own test error,
  and you name it.
- The documented example runs end to end against the real neighbour, not a mock that accepts more
  than real code. "After a crash of X" kills X itself (SIGKILL), not an exception.
- Uncertainty (failed check, partial result, unknown) leads to the safe side.
- Decide on exit codes and fields, never on a substring of text.
- Every limit or table has a test that fails without it. "File unchanged" is tested on a non-empty
  seeded copy. A test of wording is pinned to what the real reader does with it.
- Every durable record has a reader test: the consumer reads it and describes it correctly.
Self-check: a test with any of these defects is not done: vacuous (passes with the guarded
code removed), tautological (asserts what it set up, or derives the expected value from the
constant it pins), does-not-exercise-change (never reaches the changed code), wrong-expected.
Report coverage by canonical test IDs; count pass/skip/xfail/fail/error separately.
```
