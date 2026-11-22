# Evidence table

Kept per task, in the place the project's rules name (a `review.md` in the task directory, or a
ticket comment). Filled before merge; the reviewer checks it. An empty cell in a blocker row means
do not merge.

| Item | Kind | Class | Mutation applied | Test that went red | Test author | Re-run (yes/no) |
| --- | --- | --- | --- | --- | --- | --- |
| (guard, limit, allowlist) | guard | this change / old or neighbouring / doc-text-rename | what was reverted | test id | not the fix author | n/a |
| (durable record) | record | | n/a | reader test id | | n/a |
| (number or conclusion) | number | | n/a | n/a | | yes / no |

Rules: one row per claimed guard (the mutation is re-applied by the reviewer and reverted after, and
the reviewer confirms it actually applied), one row per durable record (a test where its consumer
reads it and describes it correctly), one row per number or conclusion (re-run with the reviewer's
own command). Blockers every round: false green, data loss, secret leak, hang, regression. Each test
family is passed (with scope: suites, SHA), failed, not run or not applicable; "not run" is never
hidden inside green.
