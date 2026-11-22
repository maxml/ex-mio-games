#!/usr/bin/env bash
# Local gate, run by .husky/pre-push (and by hand: `bash scripts/local-gate.sh`).
# The same checks as the CI job "checks": prompts, format, lint, typecheck, unit tests.
# MIO_GATE_STACK=1 adds most of what the CI job "stack" runs, on this worktree's own compose slot
# (scripts/stack-up.sh): compose tests, the payments Postgres suites and the demo.
#
# This is dev safety, not control: `git push --no-verify` skips it. What blocks a bad tree is
# CI on main (docs/ci.md).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
step() { printf '\n==== %s ====\n' "$*"; }

step "prompts";               bash ci/check-prompts.sh || fail=1
step "install (frozen, as CI)"; pnpm install --frozen-lockfile >/dev/null || exit 1
step "format";                pnpm format:check || fail=1
step "lint";                  pnpm nx run-many -t lint --parallel=2 || fail=1
step "typecheck";             pnpm nx run-many -t typecheck --parallel=2 || fail=1
step "unit tests";            pnpm nx run-many -t test --parallel=2 || fail=1

if [ "${MIO_GATE_STACK:-0}" = 1 ]; then
  step "stack: up on this worktree's slot"
  if bash scripts/stack-up.sh; then
    set -a; . ./.env.stack; set +a
    step "compose tests";      pnpm test:compose || fail=1
    step "payments Postgres";  POSTGRES_HOST=localhost POSTGRES_PORT="${POSTGRES_PORT:-54329}" \
                                 pnpm --filter @ex-mio/payments test:db || fail=1
    step "demo";               bash scripts/demo.sh || fail=1
    bash scripts/stack-down.sh || true
  else
    fail=1
  fi
fi

if [ "$fail" = 0 ]; then echo "LOCAL GATE GREEN"; else echo "LOCAL GATE RED: do not push"; fi
exit "$fail"
