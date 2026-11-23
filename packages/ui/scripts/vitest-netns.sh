#!/usr/bin/env bash
# Runs `vitest run` for this package in a private network namespace (loopback only) when the kernel
# allows an unprivileged one, and plainly otherwise.
#
# Why: Chromium aborts every in-flight request with net::ERR_NETWORK_CHANGED when any address on
# the host changes. On a machine where other work starts and stops docker containers, a veth comes or
# goes every few seconds. A story iframe whose module fetches are aborted that way never boots: vitest
# 4.1 has no timeout for it, so the run hung after `RUN v4.1.5` (and with dynamic imports, files failed
# with "Failed to fetch dynamically imported module"). In its own namespace Chromium sees only `lo`, so
# host interface changes cannot reach it. The vite server and the browser both live inside, so the tests
# need nothing else. Its ports are private too, so parallel runs on one machine cannot clash.
#
# MIO_UI_NETNS=0 skips the namespace. vitest.stall-guard.ts still turns any remaining stall into a
# failure with a message instead of a hang.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "${MIO_UI_NETNS:-1}" != 0 ] && command -v unshare > /dev/null && command -v ip > /dev/null \
  && unshare --user --map-root-user --net ip link set lo up 2> /dev/null; then
  # No network inside: keep Storybook from trying to send telemetry.
  export STORYBOOK_DISABLE_TELEMETRY=1
  exec unshare --user --map-root-user --net bash -c 'ip link set lo up && exec vitest run "$@"' vitest "$@"
fi

echo "ui test: no private network namespace here (unshare unavailable or not permitted); running vitest" \
  "directly, so host network changes can abort browser module loads" >&2
exec vitest run "$@"
