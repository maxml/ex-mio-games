#!/usr/bin/env bash
# Stops this worktree's stack (`down -v`), frees its slot in the ledger, removes .env.stack,
# and recovers stale ledger rows left by worktrees that no longer exist.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stack-lib.sh"
cd "$WORKTREE"

slot="$(own_slot)"
if [ -z "$slot" ] && [ -f .env.stack ]; then slot="$(sed -n 's/^MIO_SLOT=//p' .env.stack)"; fi
if [ -n "$slot" ]; then
  [ -f .env.stack ] || { echo "COMPOSE_PROJECT_NAME=mio-s$slot" >.env.stack; }
  # shellcheck disable=SC2046
  $(compose_args "$slot") down -v --remove-orphans
  release_slot "$slot"
  rm -f .env.stack
  echo "stack: slot $slot down and freed"
else
  echo "stack: this worktree has no slot"
fi
recover_stale
echo "ledger: $(ls "$LEDGER" | tr '\n' ' ')(end)"
