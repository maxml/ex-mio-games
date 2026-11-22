# Run evidence

Captured outputs of the final integration runs on commit `2aa4b7a`, 2026-11-22. Commit hashes were rewritten when
the history was published; the run is the same. Later commits change docs, test email strings, deploy wording,
the CI workflow, `scripts/setup.sh`, dependency bumps and a database init script fix.

Each file starts with a header naming the commit and the command. The files are sanitised: machine paths are
replaced by `<repo>`, the wrapper lines that queue a heavy step are removed, and nothing else is edited. Test output
is kept as captured.

| File           | Command                                         | Result                                                                                                                     |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `compose.txt`  | `pnpm test:compose` (against the compose stack) | 18 suites, 250 of 250 tests passed. The `MATRIX` lines are the role-by-route access matrix (`INV-AUD-MATRIX`).             |
| `pay-db.txt`   | `pnpm --filter @ex-mio/payments test:db`        | 8 suites, 181 of 181 passed. 255 repetitive `product_event` log lines are trimmed to 5 plus a note; the summary is intact. |
| `eng-pg.txt`   | `pnpm --filter @ex-mio/engagement test:pg`      | 4 suites, 50 of 50 passed.                                                                                                 |
| `demo-run.txt` | `scripts/demo.sh` on a fresh stack              | `DONE: 40 steps, 194 assertions passed, 0 recorded failure(s)`. Steps 32 to 40 are Part C cases C-1 to C-8.                |

The Postgres suites need the whole stack up so that every service has applied its migrations; see the README
section on tests. Tokens in the demo transcript are already `<redacted>`.
