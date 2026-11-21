#!/bin/sh
# Apply every service's migrations by running its own image's one-off entry point
# (`node dist/migrate.js`). The runtime images have no pnpm and no TypeORM CLI, so
# this is the same path the deploy plane uses.
#
# Environment:
#   IMAGE_PREFIX   image name prefix, e.g. ghcr.io/maxml (required)
#   IMAGE_TAG      tag to run (default: latest)
#   DOCKER_NETWORK network the database is reachable on (default: bridge)
#   DATABASE_SSL   disable | require | verify-full (required in production)
#   IDENTITY_MIGRATION_DATABASE_URL, ENGAGEMENT_MIGRATION_DATABASE_URL,
#   PAYMENTS_MIGRATION_DATABASE_URL
#                  URLs of each service's OWNER role (<svc>_owner), which owns the
#                  schema. The running services use their separate, unprivileged
#                  <svc>_app role (<SVC>_DATABASE_URL) and never see these.
#
# Exit 0 only if every service migrated; stops at the first failure.
set -eu

: "${IMAGE_PREFIX:?IMAGE_PREFIX is required}"
tag="${IMAGE_TAG:-latest}"
network="${DOCKER_NETWORK:-bridge}"

migrate() {
  svc="$1"
  upper=$(printf '%s' "$svc" | tr '[:lower:]' '[:upper:]')
  url=$(printenv "${upper}_MIGRATION_DATABASE_URL" || true)
  if [ -z "$url" ]; then
    echo "migrate-all: ${upper}_MIGRATION_DATABASE_URL is not set" >&2
    exit 1
  fi
  echo "migrate-all: $svc"
  docker run --rm --network "$network" \
    -e "MIGRATION_DATABASE_URL=$url" -e "NODE_ENV=${NODE_ENV:-production}" -e "DATABASE_SSL=${DATABASE_SSL:-}" \
    "${IMAGE_PREFIX}/${svc}:${tag}" node dist/migrate.js
}

migrate identity
migrate engagement
migrate payments
echo "migrate-all: done"
