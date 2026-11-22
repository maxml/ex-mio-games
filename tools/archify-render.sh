#!/usr/bin/env bash
# Re-render every architecture diagram and validate its IR.
# Usage: tools/archify-render.sh [--check]
#   (default)  validate, then render HTML next to each IR file
#   --check    validate only (fast path for CI); exits non-zero on any failure
# Requires: node >= 18 and the pinned submodule (git submodule update --init tools/archify).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$root/tools/archify/archify/bin/archify.mjs"
dir="$root/docs/architecture"

if [ ! -f "$cli" ]; then
  echo "archify CLI not found at $cli. Run: git submodule update --init tools/archify" >&2
  exit 2
fi

mode="render"
[ "${1:-}" = "--check" ] && mode="check"

# <diagram type>:<IR file stem>
diagrams=(
  architecture:architecture
  sequence:sequence
  workflow:workflow
  erd:erd
  lifecycle:lifecycle
)

fail=0
for entry in "${diagrams[@]}"; do
  type="${entry%%:*}"
  stem="${entry##*:}"
  ir="$dir/$stem.json"
  html="$dir/$stem.html"
  if ! node "$cli" validate "$type" "$ir"; then
    echo "FAIL validate: $ir" >&2
    fail=1
    continue
  fi
  if [ "$mode" = "render" ]; then
    if ! node "$cli" deliver "$type" "$ir" "$html"; then
      echo "FAIL render: $ir" >&2
      fail=1
    fi
    # The delivery receipt records absolute local paths; it is not committed.
    rm -f "$dir/$stem.delivery.json"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "archify-render: failures above" >&2
  exit 1
fi
echo "archify-render: ${#diagrams[@]} diagrams OK ($mode)"
