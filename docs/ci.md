# CI

One workflow, `.github/workflows/ci.yml`, three jobs. CI is a gate ("not obviously broken"), not a proof
of correctness; the production gate is Deckhand's (health gate, smoke, rollback), see `deploy.md`.

## Profile

- **Public repository** on a personal account. Standard GitHub-hosted Linux runners are free for public
  repositories, so the minutes are not metered and no spend guard is needed.
- **No self-hosted runner**: a self-hosted runner on a public repository would run fork code on that
  machine. The heavy part (building every image and running the compose stack) therefore stays on the
  hosted runner: it is hermetic (a throwaway stack built from this repo, dev passwords from the compose
  file, no repository secret), so it is allowed there.
- **Who triggers**: pushes to `main` (the maintainer), pull requests (Dependabot, outside contributors
  through forks, without secrets), manual `workflow_dispatch`.
- **What blocks a merge**: nothing is enforced by the platform. `main` has no branch protection, and work
  lands by direct push, so the gate is the run on `main`, read after the push. The local pre-push gate
  is dev safety only (`git push --no-verify` skips it).
- **Deploy**: outside GitHub Actions, by Deckhand on its own server (`deploy.md`). No workflow holds a
  deploy credential.

## Jobs and tiers

| Suite                                                   | Tier        | Where it runs                                                       |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `ci/check-prompts.sh`, prettier, eslint, `tsc`          | static      | job `checks` (about 2 min), pre-push, pre-commit (staged files)     |
| unit tests (`nx run-many -t test`)                      | unit        | job `checks`, pre-push                                              |
| `design/prototype`: gates, `tsc`, vitest, `vite build`  | unit        | job `prototype` (own lockfile, outside the workspace); not pre-push |
| compose tests, payments `test:db`, engagement `test:pg` | integration | job `stack` (about 13 min); pre-push with `MIO_GATE_STACK=1` [^1]   |
| `scripts/demo.sh`                                       | end to end  | job `stack`, same throwaway stack; pre-push with `MIO_GATE_STACK=1` |
| health gate, smoke, rollback                            | prod gate   | Deckhand, before and after cutover                                  |

[^1]: The local stack gate runs the compose tests and payments `test:db`; engagement `test:pg` runs in CI only.

- **Triggers**: `push` to `main`, `pull_request` to `main`, `workflow_dispatch`. A change that goes
  through a PR is gated on the PR and again on `main`; accepted because the minutes are free and the run on
  `main` is the record.
- **Docs-only PR** (only `*.md` and `docs/`): job `stack` is skipped; job `checks` still runs, because
  prettier checks the Markdown (job `prototype` has no filter and runs too). Nothing in `docs/` is read by a test or a build. A push to `main` always
  runs every job: a docs push diffed against the previous push would skip the stack even when that
  previous run was cancelled or red, so code could reach `main` with no stack run at all.
- **Dependabot PRs** get job `checks` only. The full stack runs on the branch the
  bumps are combined on and on `main`.
- `concurrency` cancels a superseded run of the same ref; every job has `timeout-minutes`; actions are
  pinned to full commit SHAs; the token is `contents: read`; checkout does not persist credentials.

## Scanners

| Scanner                              | Trigger    | Blocks                         |
| ------------------------------------ | ---------- | ------------------------------ |
| Secret scanning with push protection | push       | the push, on a detected secret |
| Human review of the lockfile diff    | every bump | the bump (see "Dependabot")    |

Owner of triage: the maintainer. Not set up yet: the dependency graph and Dependabot alerts are off
in the repository settings, so the dependency review action is refused (HTTP 403) and was taken out of
the workflow. Turning them on (Settings, Code security) and adding
`actions/dependency-review-action` (`fail-on-severity: high`) as a `pull_request` step of `checks` is
the open item. Code scanning and DAST are not set up.

## Dependabot

`.github/dependabot.yml`: npm, GitHub Actions, every Dockerfile and the compose images; monthly; one
grouped PR per ecosystem; only versions at least 7 days old (`cooldown`); semver majors ignored for npm and
images (the Node major must match `.nvmrc`, a Postgres major is a data migration, eslint 8 to 10 is a
config migration). Action majors are kept: security fixes to actions arrive as new versions.

A bump is reviewed before it lands: release notes, major or minor, the lockfile diff (new packages, and
whether any of them has an install script), then the full CI on one combined branch. Bumps that break the
build or are majors stay unmerged with a comment on the PR.

## Supply chain: open item

pnpm 9 runs the install scripts of dependencies. The tree has eight packages with one (`esbuild`, `nx`,
`@swc/core`, `unrs-resolver`, `@parcel/watcher`, `msw`, `less`, `@nestjs/core`). Moving to pnpm 10 or 12
with an allowlist (`onlyBuiltDependencies`) and `strictDepBuilds` blocks the rest; it changes the
toolchain of CI, the images and every clone, so it is a maintainer decision, not done here.
