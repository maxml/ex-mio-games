#!/usr/bin/env bash
# Shared by stack-up.sh and stack-down.sh. Defines functions and variables only; runs nothing.
#
# A "slot" is a number N (0..99). Slot N gets the project name mio-sN and every host port of
# docker-compose.yml shifted by 10*N, so slot 0 is exactly today's defaults and the highest port
# (redis 56379 + 990) stays well under 65535. Residues mod 10 differ between the published
# services, so two slots never ask for the same port.
#
# The ledger is a directory under the git common dir, which every worktree of this clone shares:
#   <common-dir>/mio-stack-slots/<N>/worktree   path of the worktree that owns the slot
# `mkdir` is the atomic claim: two scripts racing for slot N cannot both win.

PORT_VARS=(POSTGRES_PORT RABBITMQ_PORT RABBITMQ_MANAGEMENT_PORT REDIS_PORT FIREBASE_AUTH_PORT
  IDENTITY_PORT ENGAGEMENT_PORT PAYMENTS_PORT CASINO_SIM_PORT WEB_PORT)
PORT_BASE=(54329 55672 15672 56379 9099 4001 4002 4003 4004 3000)
MAX_SLOT=99

die() { printf 'stack: %s\n' "$*" >&2; exit 1; }

WORKTREE="$(git rev-parse --show-toplevel)"
LEDGER="$(cd "$WORKTREE" && realpath "$(git rev-parse --git-common-dir)")/mio-stack-slots"
mkdir -p "$LEDGER"

slot_port() { echo $((${PORT_BASE[$2]} + 10 * $1)); } # slot_port SLOT INDEX

# Who holds TCP port $1: a docker container publishing it, else the listening process.
port_holder() {
  local c
  c="$(docker ps --filter "publish=$1" --format '{{.Names}} (project {{.Label "com.docker.compose.project"}})' 2>/dev/null | head -1)"
  if [ -n "$c" ]; then echo "container $c"; return 0; fi
  ss -ltnpH "sport = :$1" 2>/dev/null | awk '{print "process " $NF}' | head -1 || true
}

# port_free PORT: a real bind on every interface, the way docker publishes. Not a lookup in a
# table: other projects on this machine hold ports no ledger knows about.
port_free() {
  python3 -c 'import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
try: s.bind(("0.0.0.0",int(sys.argv[1])))
except OSError: sys.exit(1)' "$1"
}

# busy_ports SLOT: prints one "NAME=PORT held by ..." line per port that cannot be bound.
busy_ports() {
  local i p
  for i in "${!PORT_VARS[@]}"; do
    p="$(slot_port "$1" "$i")"
    port_free "$p" || echo "${PORT_VARS[$i]}=$p held by $(port_holder "$p")"
  done
  return 0
}

has_containers() { [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=mio-s$1" 2>/dev/null)" ]; }

# Drops ledger rows that no longer describe a live stack: the worktree is gone, or the project has
# no containers and the claim is older than 90 minutes (a younger one may be mid-build or mid-startup).
recover_stale() {
  local d n wt
  for d in "$LEDGER"/*/; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    wt="$(cat "$d/worktree" 2>/dev/null || true)"
    if [ ! -d "$wt" ] || { ! has_containers "$n" && [ -n "$(find "$d" -maxdepth 0 -mmin +90)" ]; }; then
      echo "stack: recovered stale slot $n (owner: ${wt:-unknown})" >&2
      rm -rf "$d"
    fi
  done
  return 0
}

claim_slot() { # claim_slot N: succeeds if the slot was free or already ours
  if mkdir "$LEDGER/$1" 2>/dev/null; then echo "$WORKTREE" >"$LEDGER/$1/worktree"; return 0; fi
  [ "$(cat "$LEDGER/$1/worktree" 2>/dev/null)" = "$WORKTREE" ]
}

release_slot() { rm -rf "$LEDGER/$1"; }

# The slot this worktree owns right now, from its ledger row (empty if none).
own_slot() {
  local d
  for d in "$LEDGER"/*/; do
    if [ "$(cat "$d/worktree" 2>/dev/null)" = "$WORKTREE" ]; then basename "$d"; return 0; fi
  done
  return 0
}

# compose_args SLOT: the one place the compose argument list is built.
compose_args() { echo docker compose -p "mio-s$1" --env-file "$WORKTREE/.env.stack"; }

# ---- shared images -----------------------------------------------------------------------------
# Every slot at the same code runs the same ex-mio/<service>:<tag> images (see docker-compose.yml).
BUILT_SERVICES=(identity engagement payments casino-sim web firebase-auth)
BUILD_INPUTS=(apps packages docker pnpm-lock.yaml pnpm-workspace.yaml package.json nx.json
  tsconfig.base.json tsconfig.json)

# image_tag: 12 hex chars from the content of what the Dockerfiles copy. Tracked paths go in by
# git tree/blob id; a dirty worktree adds the diff and every untracked file, so an edit changes
# the tag and a clean checkout of the same code gives the same tag in every worktree.
image_tag() {
  {
    git -C "$WORKTREE" rev-parse $(printf 'HEAD:%s ' "${BUILD_INPUTS[@]}")
    git -C "$WORKTREE" diff HEAD -- "${BUILD_INPUTS[@]}"
    git -C "$WORKTREE" ls-files -o --exclude-standard -z -- "${BUILD_INPUTS[@]}" |
      (cd "$WORKTREE" && xargs -0 -r git hash-object --)
  } | sha1sum | cut -c1-12
}

# ensure_images SLOT TAG: builds only the images that are missing, one at a time, serialised
# between worktrees by a lock (the second caller finds the first one's images and builds nothing).
# MIO_HEAVY, if set, is the machine's heavy-step wrapper and prefixes each build.
ensure_images() {
  (
    flock 9
    local s
    for s in "${BUILT_SERVICES[@]}"; do
      if docker image inspect "ex-mio/$s:$2" >/dev/null 2>&1; then
        echo "stack: image ex-mio/$s:$2 exists, no build"
      else
        echo "stack: building ex-mio/$s:$2"
        # shellcheck disable=SC2046,SC2086
        COMPOSE_PARALLEL_LIMIT=1 ${MIO_HEAVY:-} $(compose_args "$1") build "$s" || exit 1 # errexit is off under the caller's `||`
      fi
    done
  ) 9>"$LEDGER/build.lock"
}
