#!/usr/bin/env bash
# Brings up this worktree's own compose stack on its own slot, so several stacks (one per
# worktree or agent) run at once. Usage: scripts/stack-up.sh [--slot N]
#
# Picks the lowest free slot from the ledger shared by all worktrees of this clone, probes every
# port of the slot with a real bind (refusing, with who holds it, rather than overlapping another
# project), writes .env.stack, and runs `docker compose up -d --wait`. Slot 0 is the default ports.
# Images are shared: ex-mio/<service>:<tag>, the tag a hash of the build inputs. Only missing
# images are built, one at a time; set MIO_HEAVY to a wrapper command to prefix each build.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stack-lib.sh"
cd "$WORKTREE"

want=""
case "${1:-}" in
  --slot) want="${2:?--slot needs a number}" ;;
  "") ;;
  *) die "usage: scripts/stack-up.sh [--slot N]" ;;
esac
[[ -z "$want" || "$want" =~ ^[0-9]+$ ]] && [ "${want:-0}" -le "$MAX_SLOT" ] || die "slot must be 0..$MAX_SLOT"

recover_stale
slot="$(own_slot)"
if [ -n "$slot" ] && [ -n "$want" ] && [ "$slot" != "$want" ]; then
  die "this worktree already owns slot $slot; run scripts/stack-down.sh first"
fi
if [ -n "$slot" ]; then
  # Our own slot: its ports are ours, but only if our stack is what holds them.
  has_containers "$slot" || busy="$(busy_ports "$slot")"
  [ -z "${busy:-}" ] || die "slot $slot ports are taken:"$'\n'"$busy"
else
  for n in $([ -n "$want" ] && echo "$want" || seq 0 "$MAX_SLOT"); do
    claim_slot "$n" || { [ -n "$want" ] && die "slot $n is owned by $(cat "$LEDGER/$n/worktree")"; continue; }
    busy="$(busy_ports "$n")"
    if [ -z "$busy" ]; then slot="$n"; break; fi
    release_slot "$n"
    [ -n "$want" ] && die "slot $n cannot be used, a port is held:"$'\n'"$busy"
    echo "stack: slot $n skipped:" >&2; sed 's/^/  /' <<<"$busy" >&2
  done
  [ -n "$slot" ] || die "no free slot in 0..$MAX_SLOT"
fi

tag="$(image_tag)"
{
  echo "# Written by scripts/stack-up.sh for slot $slot. Do not commit."
  echo "COMPOSE_PROJECT_NAME=mio-s$slot"
  echo "COMPOSE_PROJECT=mio-s$slot"
  echo "MIO_SLOT=$slot"
  echo "MIO_IMAGE_TAG=$tag"
  for i in "${!PORT_VARS[@]}"; do echo "${PORT_VARS[$i]}=$(slot_port "$slot" "$i")"; done
} >.env.stack

ensure_images "$slot" "$tag" || die "image build failed (slot $slot stays claimed; scripts/stack-down.sh frees it)"
# $(compose_args) is word-split on purpose: the list has no spaces in any element.
# shellcheck disable=SC2046
$(compose_args "$slot") up -d --no-build --wait --wait-timeout 600 || die "compose up failed (slot $slot stays claimed; scripts/stack-down.sh frees it)"

echo
echo "Slot $slot is up (project mio-s$slot). Web http://localhost:$(slot_port "$slot" 9)"
echo "Point tests and scripts/demo.sh at it:"
echo "  set -a; . $WORKTREE/.env.stack; set +a"
echo "Stop it: scripts/stack-down.sh"
