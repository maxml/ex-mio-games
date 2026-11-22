#!/usr/bin/env bash
# Removes MIO images nobody needs. Dry run by default: prints what it would delete, with sizes.
# Usage: scripts/stack-prune.sh [--yes]
#
# Deletes
#   - ex-mio/* images whose tag is not used by a live slot in the ledger, except the newest 2 tags;
#   - leftover per-project images (demo-<service>, mio-sN-<service>) from before images were shared;
#   - build cache older than 30 minutes.
# Never deletes an image that any container (running or not) uses, nor one created in the last
# 30 minutes (another agent may be about to start it).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stack-lib.sh"
KEEP_NEWEST="${MIO_KEEP_TAGS:-2}" # how many of the newest ex-mio tags survive (0 removes all unused)
yes=0; [ "${1:-}" = "--yes" ] && yes=1

# IDs of images any container uses, and tags pinned by slots in the ledger.
in_use="$(docker ps -aq | xargs -r docker inspect --format '{{.Image}}' | sort -u)"
live_tags=" $(for d in "$LEDGER"/*/; do
  if [ -f "$d/worktree" ]; then sed -n 's/^MIO_IMAGE_TAG=//p' "$(cat "$d/worktree")/.env.stack" 2>/dev/null || true; fi
done | tr '\n' ' ') "
now="$(date +%s)"
svc_re='(identity|engagement|payments|casino-sim|web|firebase-auth)'

# Newest tags by creation time (an image set is one tag).
newest=" $(docker images 'ex-mio/*' --format '{{.Tag}}|{{.CreatedAt}}' | sort -t'|' -k2 -r |
  awk -F'|' '!s[$1]++ {print $1}' | head -n "$KEEP_NEWEST" | tr '\n' ' ') "

victims=(); total=0
while IFS='|' read -r ref id size created; do
  full="$(docker image inspect --format '{{.Id}}' "$id" 2>/dev/null)" || continue
  grep -qxF "$full" <<<"$in_use" && continue                       # a container uses it
  age=$(( now - $(date -d "${created% *}" +%s 2>/dev/null || echo "$now") ))
  [ "$age" -lt 1800 ] && continue                                  # too fresh
  case "$ref" in
    ex-mio/*:*) t="${ref##*:}"
      case "$live_tags$newest" in *" $t "*) continue ;; esac ;;
    *) [[ "$ref" =~ ^(demo|mio-[a-z0-9-]+)-${svc_re}: ]] || continue ;;
  esac
  victims+=("$ref"); printf '  %-48s %s\n' "$ref" "$size"
done < <(docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}')

echo "images to delete: ${#victims[@]} (sizes are per tag; tags of one image share its layers)"
echo "build cache (the prune below drops what is older than 30m):"; docker system df | grep -E 'TYPE|Build Cache'
if [ "$yes" = 1 ]; then
  [ "${#victims[@]}" -eq 0 ] || docker rmi "${victims[@]}"
  docker builder prune -f --filter until=30m | tail -1
else
  echo "dry run: nothing deleted. Run scripts/stack-prune.sh --yes to delete."
fi
